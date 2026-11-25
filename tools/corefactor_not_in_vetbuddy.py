#!/usr/bin/env python3
"""
One-off list: Corefactor numbers (whole Backend Call Log master + today's webhook calls) that are NOT VetBuddy
customers, without DND and deceased numbers. Writes an Excel file to SharePoint next to the master.

VetBuddy numbers = vetbuddy.sales (20 Dec 2025 ->) + vetbuddy.sales_old_summary (2019 -> 19 Dec 2025).
DND = calldesk.exclusions (reason dnd). Deceased = calldesk.deceased_map (all pets dead) + calldesk.deceased_marked.
The log prints counts only - never a phone number (the repo is public).
"""
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import quote

import openpyxl
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import vetbuddy_sales_export as vx  # noqa: E402
import vetbuddy_sql as vs  # noqa: E402

log = vx.log
SITE = os.environ.get("SP_CALLLOG_SITE_URL", "")
LIB = os.environ.get("SP_CALLLOG_LIBRARY", "Documents")
MASTER = os.environ.get("SP_CALLLOG_MASTER_PATH", "Sanchu Reports/Backend Call Log Report.xlsx").strip("/")
OUT_FOLDER = os.environ.get("OUT_FOLDER", "Sanchu Reports")
WORK = Path(os.environ.get("OUTPUT_DIR", "/tmp/cfx"))
OK = re.compile(r"^[6-9]\d{9}$")


def norm(v):
    if v is None:
        return None
    if isinstance(v, float):
        v = int(v)
    d = re.sub(r"\D", "", str(v))[-10:]
    return d if OK.match(d) else None


def as_dt(v):
    if isinstance(v, datetime):
        return v
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day)
    if isinstance(v, (int, float)) and 20000 < v < 80000:
        return datetime(1899, 12, 30) + __import__("datetime").timedelta(days=float(v))
    if isinstance(v, str):
        for f in ("%d-%m-%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d/%m/%Y %H:%M:%S"):
            try:
                return datetime.strptime(v.strip()[:19], f)
            except ValueError:
                pass
    return None


agg = {}


def add(phone, when, name, ctype, status, agent):
    a = agg.get(phone)
    if a is None:
        a = agg[phone] = {"name": "", "calls": 0, "in": 0, "out": 0, "ans": 0,
                          "first": None, "last": None, "status": "", "agent": ""}
    a["calls"] += 1
    t = (ctype or "").lower()
    if t.startswith("in"):
        a["in"] += 1
    elif t.startswith("out"):
        a["out"] += 1
    if (status or "").strip().lower() == "answered":
        a["ans"] += 1
    if when and (a["first"] is None or when < a["first"]):
        a["first"] = when
    if when and (a["last"] is None or when >= a["last"]):
        a["last"] = when
        a["status"] = status or a["status"]
        a["agent"] = agent or a["agent"]
        if name:
            a["name"] = name
    elif name and not a["name"]:
        a["name"] = name


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    h = {"Authorization": f"Bearer {vx.graph_token()}"}
    drive = vx.sp_drive(h, SITE, LIB)

    # 1. the master workbook (all Corefactor calls from the start)
    r = requests.get(f"{vx.GRAPH}/drives/{drive['id']}/root:/{quote(MASTER)}", headers=h, timeout=60)
    vx._check(r, "Finding the call log master")
    item = r.json()
    local = WORK / "calllog_master.xlsx"
    log.info("Downloading '%s' (%.0f MB)...", MASTER, item.get("size", 0) / 1e6)
    with requests.get(f"{vx.GRAPH}/drives/{drive['id']}/items/{item['id']}/content", headers=h,
                      stream=True, timeout=900) as resp:
        vx._check(resp, "Downloading the master")
        with open(local, "wb") as f:
            for b in resp.iter_content(1 << 20):
                f.write(b)

    wb = openpyxl.load_workbook(local, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    ix, rows, master_last = None, 0, None
    for row in ws.iter_rows(values_only=True):
        if ix is None:
            names = [str(c).strip() if c is not None else "" for c in row]
            if "Customer Number" in names:
                ix = {n: i for i, n in enumerate(names) if n}
            continue
        g = lambda k: row[ix[k]] if k in ix and ix[k] < len(row) else None  # noqa: E731
        ph = norm(g("Customer Number"))
        if not ph:
            continue
        when = as_dt(g("Start Time")) or as_dt(g("Call Date"))
        if when and (master_last is None or when > master_last):
            master_last = when
        add(ph, when, (g("Customer Name") or "").strip() if isinstance(g("Customer Name"), str) else "",
            g("Call Type"), g("Call Status"), g("Agent Name"))
        rows += 1
    wb.close()
    if ix is None:
        raise RuntimeError("No 'Customer Number' header found in the master")
    log.info("Master: %d call rows with a valid number, %d different numbers, last call %s", rows, len(agg), master_last)

    con = vs.connect()
    cur = con.cursor()
    # 2. calls after the master's last day (webhook, today)
    cur.execute("select phone, call_at, customer_name, direction, status, agent from calldesk.calls "
                "where source = 'Corefactor' and call_at::date > %s", ((master_last or datetime(2000, 1, 1)).date(),))
    extra = 0
    for ph, at, nm, d, st, ag in cur.fetchall():
        ph = norm(ph)
        if ph:
            add(ph, at, nm or "", "Inbound" if d == "in" else "Outbound", st, ag)
            extra += 1
    log.info("Webhook calls after the master: %d", extra)

    # 3. VetBuddy, DND, deceased
    cur.execute("select distinct right(regexp_replace(coalesce(client_phone,''), '\\D', '', 'g'), 10) from vetbuddy.sales "
                "union select right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) from vetbuddy.sales_old_summary")
    vb = {p for (p,) in cur.fetchall() if p}
    cur.execute("select right(regexp_replace(phone, '\\D', '', 'g'), 10) from calldesk.exclusions where reason = 'dnd'")
    dnd = {p for (p,) in cur.fetchall() if p}
    cur.execute("select right(regexp_replace(phone, '\\D', '', 'g'), 10) from calldesk.deceased_map where all_dead "
                "union select right(regexp_replace(phone, '\\D', '', 'g'), 10) from calldesk.deceased_marked where phone is not null")
    dead = {p for (p,) in cur.fetchall() if p}
    con.close()

    total = len(agg)
    in_vb = sum(1 for p in agg if p in vb)
    not_vb = [p for p in agg if p not in vb]
    n_dnd = sum(1 for p in not_vb if p in dnd)
    n_dead = sum(1 for p in not_vb if p in dead and p not in dnd)
    keep = [p for p in not_vb if p not in dnd and p not in dead]
    log.info("Corefactor numbers %d | in VetBuddy %d | not in VetBuddy %d | minus DND %d | minus deceased %d | final %d",
             total, in_vb, len(not_vb), n_dnd, n_dead, len(keep))

    # 4. Excel
    keep.sort(key=lambda p: agg[p]["last"] or datetime(1900, 1, 1), reverse=True)
    out = openpyxl.Workbook()
    ws = out.active
    ws.title = "Not in VetBuddy"
    ws.append(["Phone", "Customer Name (Corefactor)", "Total Calls", "Incoming", "Outgoing", "Answered",
               "First Call", "Last Call", "Last Call Status", "Last Agent"])
    for p in keep:
        a = agg[p]
        ws.append([p, a["name"], a["calls"], a["in"], a["out"], a["ans"], a["first"], a["last"], a["status"], a["agent"]])
    for c in ("G", "H"):
        for cell in ws[c][1:]:
            cell.number_format = "dd-mm-yyyy hh:mm"
    widths = [13, 28, 11, 10, 10, 10, 17, 17, 22, 22]
    for i, w in enumerate(widths):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i + 1)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    s = out.create_sheet("Summary")
    for k, v in [("Corefactor numbers (all calls, from the start)", total), ("Matched VetBuddy", in_vb),
                 ("Not in VetBuddy", len(not_vb)), ("Removed: DND", n_dnd), ("Removed: deceased", n_dead),
                 ("Final list", len(keep)), ("Calls up to", (master_last or "").__str__() + " + today's webhook calls"),
                 ("VetBuddy numbers checked", "VetBuddy sales 20 Dec 2025 -> now + old customers 2019 -> 19 Dec 2025"),
                 ("Made", datetime.now().strftime("%d-%m-%Y %H:%M"))]:
        s.append([k, v])
    s.column_dimensions["A"].width = 46
    s.column_dimensions["B"].width = 60
    name = f"Corefactor_Not_In_VetBuddy_{date.today():%Y-%m-%d}.xlsx"
    path = WORK / name
    out.save(path)
    res = vx.sp_put_file(h, drive["id"], path, f"{OUT_FOLDER.strip('/')}/{name}")
    log.info("Uploaded: %s/%s %s", OUT_FOLDER, name, res.get("webUrl", ""))
    # hand-over copy for the chat (dropped after it is picked up)
    con = vs.connect()
    with con.cursor() as c:
        c.execute("create table if not exists calldesk.tmp_export (name text primary key, data bytea, made_at timestamptz default now())")
        c.execute("insert into calldesk.tmp_export (name, data) values (%s, %s) on conflict (name) do update "
                  "set data = excluded.data, made_at = now()", (name, path.read_bytes()))
    con.commit()
    con.close()
    log.info("Hand-over copy stored (%d KB)", path.stat().st_size // 1024)
    path.unlink(missing_ok=True)
    local.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
