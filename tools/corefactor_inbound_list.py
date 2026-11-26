#!/usr/bin/env python3
"""
One-off: every Corefactor INBOUND caller (whole Backend Call Log master + webhook calls after it), one row per number,
-> the 10,000 most recent (minus DND and deceased) as an Excel file in SharePoint next to the master.
The master is opened from the sharing link in CF_LINK. The log prints counts only - never a phone number (public repo).
"""
import base64, os, re, sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
import openpyxl, requests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import vetbuddy_sales_export as vx  # noqa: E402
import vetbuddy_sql as vs  # noqa: E402
from tools.corefactor_not_in_vetbuddy import norm, as_dt  # noqa: E402

log = vx.log
SITE = os.environ.get("SP_CALLLOG_SITE_URL", "")
LIB = os.environ.get("SP_CALLLOG_LIBRARY", "Documents")
MASTER = os.environ.get("SP_CALLLOG_MASTER_PATH", "Sanchu Reports/Backend Call Log Report.xlsx").strip("/")
WORK = Path(os.environ.get("OUTPUT_DIR", "/tmp/cfi"))
TAKE = int(os.environ.get("TAKE", "10000"))
agg = {}


def add(p, when, name, status, agent):
    a = agg.setdefault(p, {"name": "", "calls": 0, "ans": 0, "first": None, "last": None, "status": "", "agent": ""})
    a["calls"] += 1
    if (status or "").strip().lower() == "answered":
        a["ans"] += 1
    if when and (a["first"] is None or when < a["first"]):
        a["first"] = when
    if when and (a["last"] is None or when >= a["last"]):
        a["last"], a["status"], a["agent"] = when, status or "", agent or ""
        if name:
            a["name"] = name
    elif name and not a["name"]:
        a["name"] = name


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    h = {"Authorization": f"Bearer {vx.graph_token()}"}
    drive = vx.sp_drive(h, SITE, LIB)
    link = os.environ.get("CF_LINK", "").strip()
    if link:   # the sheet the user linked
        enc = "u!" + base64.urlsafe_b64encode(link.encode()).decode().rstrip("=")
        r = requests.get(f"{vx.GRAPH}/shares/{enc}/driveItem", headers=h, timeout=60)
    else:
        r = requests.get(f"{vx.GRAPH}/drives/{drive['id']}/root:/{quote(MASTER)}", headers=h, timeout=60)
    vx._check(r, "Finding the call log master")
    item = r.json()
    log.info("Reading '%s' (%.0f MB, last changed %s)", item.get("name"), item.get("size", 0) / 1e6, item.get("lastModifiedDateTime"))
    local = WORK / "master.xlsx"
    with requests.get(f"{vx.GRAPH}/drives/{drive['id']}/items/{item['id']}/content", headers=h, stream=True, timeout=900) as resp:
        vx._check(resp, "Downloading the master")
        with open(local, "wb") as f:
            for b in resp.iter_content(1 << 20):
                f.write(b)
    ws = openpyxl.load_workbook(local, read_only=True, data_only=True).worksheets[0]
    ix, rows, inbound, last = None, 0, 0, None
    for row in ws.iter_rows(values_only=True):
        if ix is None:
            names = [str(c).strip() if c is not None else "" for c in row]
            if "Customer Number" in names:
                ix = {n: i for i, n in enumerate(names) if n}
            continue
        g = lambda k: row[ix[k]] if k in ix and ix[k] < len(row) else None  # noqa: E731
        rows += 1
        when = as_dt(g("Start Time")) or as_dt(g("Call Date"))
        if when and (last is None or when > last):
            last = when
        if not str(g("Call Type") or "").strip().lower().startswith("in"):
            continue
        p = norm(g("Customer Number"))
        if not p:
            continue
        nm = g("Customer Name")
        add(p, when, nm.strip() if isinstance(nm, str) else "", g("Call Status"), g("Agent Name"))
        inbound += 1
    log.info("Master: %d rows, %d inbound calls, %d inbound numbers, last call %s", rows, inbound, len(agg), last)
    con = vs.connect()
    cur = con.cursor()
    cur.execute("select phone, call_at, customer_name, status, agent from calldesk.calls where source = 'Corefactor' "
                "and direction = 'in' and call_at::date > %s", ((last or datetime(2000, 1, 1)).date(),))
    n = 0
    for p, at, nm, st, ag in cur.fetchall():
        p = norm(p)
        if p:
            add(p, at, nm or "", st, ag); n += 1
    log.info("Webhook inbound calls after the master: %d; inbound numbers now %d", n, len(agg))
    cur.execute("select right(regexp_replace(phone, '\\D', '', 'g'), 10) from calldesk.exclusions where reason = 'dnd' "
                "union select right(regexp_replace(phone, '\\D', '', 'g'), 10) from calldesk.queue where outcome = 'dnd'")
    dnd = {p for (p,) in cur.fetchall() if p}
    cur.execute("select right(regexp_replace(phone, '\\D', '', 'g'), 10) from calldesk.deceased_map where all_dead "
                "union select right(regexp_replace(phone, '\\D', '', 'g'), 10) from calldesk.deceased_marked where phone is not null")
    dead = {p for (p,) in cur.fetchall() if p}
    con.close()
    keep = [p for p in agg if p not in dnd and p not in dead]
    keep.sort(key=lambda p: agg[p]["last"] or datetime(1900, 1, 1), reverse=True)
    top = keep[:TAKE]
    log.info("Inbound numbers %d | DND removed %d | deceased removed %d | eligible %d | in file %d",
             len(agg), sum(1 for p in agg if p in dnd), sum(1 for p in agg if p in dead and p not in dnd), len(keep), len(top))
    out = openpyxl.Workbook()
    ws = out.active
    ws.title = "Inbound 10,000"
    ws.append(["S.No", "Phone", "Customer Name (Corefactor)", "Inbound Calls", "Answered", "First Inbound Call",
               "Last Inbound Call", "Last Call Status", "Last Agent"])
    for i, p in enumerate(top, 1):
        a = agg[p]
        ws.append([i, p, a["name"], a["calls"], a["ans"], a["first"], a["last"], a["status"], a["agent"]])
    for col in ("F", "G"):
        for c in ws[col][1:]:
            c.number_format = "dd-mm-yyyy hh:mm"
    for i, w in enumerate([7, 13, 28, 12, 10, 17, 17, 22, 22], 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w
    for c in ws[1]:
        c.font = openpyxl.styles.Font(bold=True)
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions
    sm = out.create_sheet("Summary")
    for k, v in [("Source", "Backend Call Log Report (Corefactor) - Call Type Inbound, whole file + today's webhook calls"),
                 ("Calls up to", str(last)), ("Inbound numbers (unique)", len(agg)),
                 ("Removed: DND", sum(1 for p in agg if p in dnd)), ("Removed: deceased", sum(1 for p in agg if p in dead and p not in dnd)),
                 ("Eligible", len(keep)), ("In this file (most recent inbound first)", len(top)),
                 ("Made", datetime.now().strftime("%d-%m-%Y %H:%M"))]:
        sm.append([k, v])
    sm.column_dimensions["A"].width = 42; sm.column_dimensions["B"].width = 80
    name = f"Corefactor_Inbound_{len(top)}_{datetime.now():%Y-%m-%d}.xlsx"
    path = WORK / name
    out.save(path)
    folder = "/".join(MASTER.split("/")[:-1]) or "Sanchu Reports"
    res = vx.sp_put_file(h, item["parentReference"]["driveId"], path, f"{folder}/{name}")
    log.info("Uploaded: %s/%s %s", folder, name, res.get("webUrl", ""))
    path.unlink(missing_ok=True); local.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
