#!/usr/bin/env python3
"""Test the fast (Graph) Lead Box append on a COPY of Backend Leadbox Report.xlsx. The real file is only read.
1. copies the master to 'Sanchu Reports/_test/Backend Leadbox Report TEST.xlsx'
2. appends the day's leads to the copy with corefactor_leadbox_api.py --engine graph --stage excel
3. downloads the copy and checks: row count for the day, formulas dragged down, header untouched,
   and compares the new rows cell by cell with what the old (openpyxl) method would have written."""
import io, os, subprocess, sys, time
from datetime import datetime
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import corefactor_calllogs_export as cf  # noqa: E402
import corefactor_leadbox_api as la  # noqa: E402

cf.setup_logging(); log = cf.log
day = sys.argv[1]
src = os.environ.get("SP_LEADBOX_MASTER_PATH") or "Sanchu Reports/Backend Leadbox Report.xlsx"
test_dir, test_name = "Sanchu Reports/_test", "Backend Leadbox Report TEST.xlsx"
sp = cf.SharePoint.from_env("SP_LEADBOX_SITE_URL", "SP_LEADBOX_LIBRARY")
VERIFY_ONLY = len(sys.argv) > 2 and sys.argv[2] == "verify"
sp.ensure_folder(test_dir)
parent = sp._get(sp._item(test_dir)).json()
t0 = time.time()
if VERIFY_ONLY:
    log.info("Verify only: reading the test copy as it is now")
r = None if VERIFY_ONLY else requests.post(sp._item(src) + ":/copy?@microsoft.graph.conflictBehavior=replace", headers=sp.h, timeout=60,
                  json={"parentReference": {"driveId": sp.drive, "id": parent["id"]}, "name": test_name})
if r is not None and r.status_code not in (202, 200):
    raise SystemExit(f"copy failed {r.status_code} {r.text[:300]}")
mon = None if r is None else r.headers.get("Location")
while mon:
    j = requests.get(mon, timeout=60).json()
    if j.get("status") in ("completed",) or j.get("resourceId"):
        break
    if j.get("status") == "failed":
        raise SystemExit(f"copy failed: {j}")
    time.sleep(5)
log.info("Copied the master to %s/%s in %.0fs", test_dir, test_name, time.time() - t0)
test_path = f"{test_dir}/{test_name}"

t0 = time.time()
rc = 0 if VERIFY_ONLY else subprocess.call([sys.executable, "corefactor_leadbox_api.py", "--date", day, "--stage", "excel", "--engine", "graph",
                      "--if-present", "replace", "--master-path", test_path])
log.info("Fast append finished (exit %s) in %.0fs", rc, time.time() - t0)
if rc:
    raise SystemExit(rc)

# check: download the copy and look at it with openpyxl (formulas) and with cached values
from openpyxl import load_workbook
data, _ = sp.download(test_path)
wb = load_workbook(io.BytesIO(data))
ws = wb.worksheets[0]
hdr = {c.value: c.column for c in ws[1] if c.value}
last = ws.max_row
while last > 1 and all(ws.cell(last, c).value in (None, "") for c in hdr.values()):
    last -= 1
dcol, ccol = hdr.get("Date"), hdr.get("Created Date")
rows = [r for r in range(max(2, last - 4000), last + 1) if cf.as_date(ws.cell(r, ccol).value) == datetime.strptime(day, "%Y-%m-%d").date()
        or (isinstance(ws.cell(r, ccol).value, str) and ws.cell(r, ccol).value.startswith(day))]
log.info("Copy: last row %d, rows for %s: %d (rows %s-%s)", last, day, len(rows), rows[0] if rows else '-', rows[-1] if rows else '-')
for name in ("Date", "Appt Datevalue"):
    c = hdr.get(name)
    if c:
        log.info("  %s formula in first/last new row: %r / %r (row above: %r)", name, ws.cell(rows[0], c).value,
                 ws.cell(last, c).value, ws.cell(rows[0] - 1, c).value)
for name in ("Unique ID", "Created Date", "Mobile", "Lead Status", "Lead Source", "Modified Date"):
    c = hdr.get(name)
    if c:
        a, b = ws.cell(rows[0] - 1, c), ws.cell(rows[0], c)
        log.info("  %-14s row above: %r (%s) | new row: %r (%s)", name, a.value, a.number_format, b.value, b.number_format)
leads = la.fetch(datetime.strptime(day, "%Y-%m-%d").date())
log.info("API leads for %s: %d -> %s", day, len(leads), "MATCH" if len(leads) == len(rows) else "DIFFERENT")
