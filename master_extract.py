#!/usr/bin/env python3
"""
Extract a date range from the VetBuddy master workbook ("Vetbuddy Master Data 2.xlsx" on SharePoint)
into a new Excel file with the same columns (values; formulas as their last calculated value).

Usage:  python master_extract.py --from 2026-04-01 --to 2026-11-12 --name APR_NOV_VB
Env:    SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_MASTER_SITE_URL, SP_MASTER_LIBRARY, SP_MASTER_PATH,
        OUTPUT_DIR (default ./reports)
Read-only: the master is only downloaded, never changed.
"""
import argparse
import datetime as dt
import io
import logging
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import corefactor_calllogs_export as cf   # noqa: E402  SharePoint helper

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("extract")
EPOCH = dt.datetime(1899, 12, 30)


def as_day(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (int, float)) and 20000 < v < 80000:
        return (EPOCH + dt.timedelta(days=float(v))).date()
    p = cf.parse_dt(v) if v else None
    return p.date() if p else None


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--from", dest="d_from", required=True)
    a.add_argument("--to", dest="d_to", required=True)
    a.add_argument("--name", required=True)
    a = a.parse_args()
    first, last = dt.date.fromisoformat(a.d_from), dt.date.fromisoformat(a.d_to)
    path = os.environ.get("SP_MASTER_PATH") or "Vetbuddy Master Data 2.xlsx"
    sp = cf.SharePoint.from_env("SP_MASTER_SITE_URL", "SP_MASTER_LIBRARY")
    data, _ = sp.download(path)
    log.info("Downloaded master %s (%.1f MB)", path, len(data) / 1e6)

    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Font
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = list(next(rows))
    while header and header[-1] in (None, ""):
        header.pop()
    n = len(header)
    log.info("Sheet '%s', %d columns: %s", ws.title, n, ", ".join(str(h) for h in header[:8]))

    out = Workbook(write_only=True)
    sh = out.create_sheet("Sheet1")
    sh.append(header)
    kept = seen = 0
    days = {}
    for r in rows:
        seen += 1
        r = list(r[:n]) + [None] * (n - len(r[:n]))
        if all(v in (None, "") for v in r):
            continue
        d = as_day(r[1])
        if d and first <= d <= last:
            sh.append(r)
            kept += 1
            days[d.strftime("%Y-%m")] = days.get(d.strftime("%Y-%m"), 0) + 1
    log.info("Rows read: %d, kept %d (%s .. %s)", seen, kept, first, last)
    for m in sorted(days):
        log.info("  %s: %d rows", m, days[m])
    outdir = Path(os.environ.get("OUTPUT_DIR") or HERE / "reports")
    outdir.mkdir(parents=True, exist_ok=True)
    dest = outdir / f"{a.name}.xlsx"
    out.save(dest)
    log.info("Saved %s (%.1f MB)", dest, dest.stat().st_size / 1e6)
    return 0 if kept else 1


if __name__ == "__main__":
    sys.exit(main())
