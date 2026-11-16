#!/usr/bin/env python3
"""
One-time: load the OLD VetBuddy master ("Sanchu Reports/Vetbuddy Master Data.xlsx", before 20 Dec 2025)
into vetbuddy.sales, next to the current data.

  * Only rows dated BEFORE the first date already in vetbuddy.sales are loaded (today: 20 Dec 2025),
    so the daily data (Vetbuddy Master Data 2.xlsx) is never touched or duplicated.
  * Safe to run again: it first removes rows before that date, then loads them again (one transaction).
  * The old workbook is only downloaded - never changed.
  * Afterwards the Power BI summary views (mv_pbi_*) are refreshed so visit counts / spend use the full history.

Usage:  python history_load.py --check     read the file, report dates / rows / columns, change nothing
        python history_load.py --load      load it
Env:    SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_MASTER_SITE_URL, SP_MASTER_LIBRARY,
        SP_MASTER_PATH (the current master - the old file is looked for in the same folder),
        HISTORY_PATH (optional: the old file's path), SUPABASE_DB_URL, OUTPUT_DIR
"""
import collections
import datetime as dt
import logging
import os
import posixpath
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# the old file: same folder as the current master unless HISTORY_PATH says otherwise
_cur = (os.environ.get("SP_MASTER_PATH") or "Vetbuddy Master Data 2.xlsx").strip("/")
OLD = (os.environ.get("HISTORY_PATH") or posixpath.join(posixpath.dirname(_cur), "Vetbuddy Master Data.xlsx")).strip("/")
os.environ["SP_MASTER_PATH"] = OLD            # the download helper reads this name

import vetbuddy_sales_export as vx            # noqa: E402  SharePoint download helper, settings
import vetbuddy_sql as vs                     # noqa: E402  row conversion, COPY into vetbuddy.sales

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("history")


def main() -> int:
    load = "--load" in sys.argv
    if not (vx.SP_ENABLED and vs.ENABLED):
        log.error("Needs the SharePoint settings and SUPABASE_DB_URL")
        return 1
    h = {"Authorization": f"Bearer {vx.graph_token()}"}
    local = vx.OUTPUT_DIR / "_history" / "old_master.xlsx"
    vx.sp_download_master(h, vx.sp_drive(h, vx.SP_MASTER_SITE_URL, vx.SP_MASTER_LIBRARY), local)

    with vs.connect() as conn, conn.cursor() as cur:
        cur.execute("select min(sale_date), max(sale_date), count(*) from vetbuddy.sales "
                    "where sale_date >= coalesce((select min(sale_date) from vetbuddy.sales "
                    "where sale_date >= date '2025-12-01'), date '2025-12-20')")
        first_new, last_new, n_new = cur.fetchone()
    cutoff = first_new or dt.date(2025, 12, 20)
    log.info("Database now: %s .. %s (%d rows). Old rows are loaded only before %s.", first_new, last_new, n_new, cutoff)

    it = vs.iter_master_rows(local)
    header = next(it)
    log.info("Old master columns (%d): %s", len([x for x in header if x]), ", ".join(str(x) for x in header if x))
    if str(header[1]).strip().lower() != "date" or str(header[0]).strip().lower() != "sr no.":
        log.error("Header looks different from the current master: %s - nothing loaded", header[:4])
        return 1
    scan = vs.iter_master_rows(local)
    next(scan)
    vow_inv = vs.vow_invoice_set(header, scan)

    stats = collections.Counter()
    months = collections.Counter()
    span = [None, None]

    def records():
        for vals in it:
            if all(v in (None, "") for v in vals):
                continue
            rec = vs.to_record(header, vals, vow_inv)
            if rec is None:
                stats["no date"] += 1
                continue
            d = rec["sale_date"]
            if d >= cutoff.isoformat():
                stats["on/after cutoff (already in the database)"] += 1
                continue
            stats["loaded"] += 1
            months[d[:7]] += 1
            span[0] = d if span[0] is None or d < span[0] else span[0]
            span[1] = d if span[1] is None or d > span[1] else span[1]
            yield rec

    if not load:
        for _ in records():
            pass
        log.info("CHECK ONLY - nothing changed. Rows before %s: %d, dates %s .. %s", cutoff, stats["loaded"], span[0], span[1])
        for k, v in stats.items():
            log.info("  %-45s %d", k, v)
        for m in sorted(months):
            log.info("  %s  %7d rows", m, months[m])
        return 0

    with vs.connect() as conn:                       # one transaction: all or nothing
        with conn.cursor() as cur:
            cur.execute("DELETE FROM vetbuddy.sales WHERE sale_date < %s", (cutoff,))
            deleted = cur.rowcount
            inserted = vs._insert(cur, records())
            cur.execute("INSERT INTO vetbuddy.load_log (date_from, date_to, rows_deleted, rows_inserted, kind) "
                        "VALUES (%s, %s, %s, %s, 'history')", (span[0], span[1], deleted, inserted))
    log.info("History loaded: %d rows (%s .. %s), %d old rows replaced, %d VOW invoices",
             inserted, span[0], span[1], deleted, len(vow_inv))
    for k, v in stats.items():
        log.info("  %-45s %d", k, v)
    with vs.connect() as conn, conn.cursor() as cur:
        cur.execute("select vetbuddy.refresh_pbi()")
        log.info("Summary views: %s", cur.fetchone()[0])
    local.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
