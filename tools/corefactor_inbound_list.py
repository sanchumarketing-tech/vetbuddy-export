#!/usr/bin/env python3
"""
One-off: every Corefactor INBOUND caller (whole Backend Call Log master + webhook calls after it), one row per number,
into calldesk.tmp_cf_inbound (dropped after use). The log prints counts only - never a phone number (public repo).
"""
import os, re, sys
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
    r = requests.get(f"{vx.GRAPH}/drives/{drive['id']}/root:/{quote(MASTER)}", headers=h, timeout=60)
    vx._check(r, "Finding the call log master")
    item = r.json()
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
    cur.execute("delete from calldesk.tmp_cf_inbound")
    data = [(p, a["name"][:120], a["calls"], a["ans"], a["first"], a["last"], (a["status"] or "")[:60], (a["agent"] or "")[:80]) for p, a in agg.items()]
    for i in range(0, len(data), 5000):
        cur.executemany("insert into calldesk.tmp_cf_inbound values (%s,%s,%s,%s,%s,%s,%s,%s)", data[i:i + 5000])
    con.commit(); con.close()
    log.info("Stored %d inbound numbers", len(data))


if __name__ == "__main__":
    main()
