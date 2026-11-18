#!/usr/bin/env python3
"""
Corefactor call logs / Lead Box from the database -> SharePoint master sheet (no Corefactor session needed).

Corefactor pushes every call and lead to the Call Desk webhooks (/api/corefactor-calls, /api/corefactor-leads),
which keep each push in calldesk.cf_live_raw. Each morning this job takes yesterday's pushes and does what the
session-based jobs did:
  1. saves the day's file in the archive folder (Corefactor_CallLogs_<day>.csv / Corefactor_LeadBox_<day>.csv),
     which the Call Desk load and the reminder-calls check read;
  2. appends the rows to the master workbook (Backend Call Log Report.xlsx / Backend Leadbox Report.xlsx),
     matching the pushed field names to the master's headers, and drags the formula columns down.
A day already in the master is skipped (as before), so while the old job still runs nothing is added twice.
No pushes for the day -> nothing is changed.

Usage: python corefactor_from_db.py --report calllogs|leadbox [--date YYYY-MM-DD] [--if-present skip|replace]
Env:   SUPABASE_DB_URL, SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE_URL, SP_LIBRARY (archive),
       SP_CALLLOG_* / SP_LEADBOX_* (master site, library, path), as in the existing workflows.
"""
import argparse
import csv
import io
import sys
import time
from collections import Counter
from datetime import datetime, timedelta

import corefactor_calllogs_export as cf
import vetbuddy_sql as vs

log = cf.log


def pushes(kind, day):
    """The pushes of one kind for the day (by the call / created date in the push, else the time received)."""
    with vs.connect() as conn, conn.cursor() as cur:
        cur.execute("""select body, received_at at time zone 'Asia/Kolkata' from calldesk.cf_live_raw
                       where kind = %s and received_at >= %s::date - 2 and received_at < %s::date + 3
                       order by id""", (kind, day, day))
        return cur.fetchall()


def flatten(body):
    if isinstance(body, list):
        body = body[0] if body else {}
    if not isinstance(body, dict):
        return {}
    out = dict(body)
    for k in ("data", "call", "lead"):
        if isinstance(body.get(k), dict):
            out.update(body[k])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", choices=["calllogs", "leadbox"], required=True)
    ap.add_argument("--date")
    ap.add_argument("--if-present", choices=["skip", "replace"], default="skip")
    args = ap.parse_args()
    cf.setup_logging()
    report = cf.CALL_LOGS if args.report == "calllogs" else cf.LEAD_BOX
    kind = "call" if args.report == "calllogs" else "lead"
    day = (datetime.strptime(args.date, "%Y-%m-%d").date() if args.date
           else datetime.now(cf.IST).date() - timedelta(days=1))
    log.info("Corefactor %s for %s, from the database (webhook pushes)", report.title, day)

    date_key = cf.norm(report.get("FALLBACK_DATE_COLUMN"))       # "Call Date" / "Created Date"
    recs = []
    for body, received in pushes(kind, day):
        b = {cf.norm(k): v for k, v in flatten(body).items()}
        when = next((cf.parse_dt(b[k]) for k in (date_key, "starttime", "calldate", "createddate", "createdat", "date")
                     if b.get(k) not in (None, "") and cf.parse_dt(b[k])), None) or received
        if when.date() == day:
            recs.append(b)
    if kind == "lead":           # a lead can be pushed again when it changes: keep its latest version
        latest = {}
        for b in recs:
            latest[str(b.get("uniqueid") or b.get("leadid") or b.get("id") or id(b))] = b
        recs = list(latest.values())
    else:                        # the same call pushed twice
        seen, keep = set(), []
        for b in recs:
            k = repr(sorted(b.items()))
            if k not in seen:
                seen.add(k)
                keep.append(b)
        recs = keep
    if not recs:
        log.warning("No pushes for %s - nothing changed (the Corefactor webhook may not be sending yet)", day)
        return 0

    sp = cf.SharePoint.from_env(f"{report.prefix}_SITE_URL", f"{report.prefix}_LIBRARY")
    path = report.get("MASTER_PATH", required=True)
    for attempt in range(1, 6):
        wb_bytes, etag = sp.download(path)
        master = cf.Master(wb_bytes, report)
        if master.has_day(day):
            if args.if_present == "skip":
                log.info("The master already has %s - left unchanged", day)
                return 0
            master.remove_day(day)
        # the master's own columns, in order, minus the drag-down formula columns
        formula = {ci for ci in master.headers
                   for r in range(master.last, max(master.hr, master.last - 500), -1)
                   if isinstance(master.ws.cell(r, ci).value, str) and str(master.ws.cell(r, ci).value).startswith("=")}
        header = [str(master.headers[ci]).strip() for ci in sorted(master.headers) if ci not in formula]
        keys = [cf.norm(h) for h in header]
        unmatched = Counter(k for b in recs for k in b if k not in keys)
        missing = [h for h, k in zip(header, keys) if not any(b.get(k) not in (None, "") for b in recs)]
        if unmatched:
            log.info("Pushed fields not in the master (ignored): %s", ", ".join(sorted(unmatched)))
        if missing:
            log.warning("Master columns with no pushed value today: %s", ", ".join(missing))
        if len(missing) > len(header) * 0.6:
            raise cf.RunError("Most master columns are missing from the pushes - the field names differ from the "
                              "master's headers. Nothing was changed; check calldesk.cf_live_raw.")
        rows = [[b.get(k) for k in keys] for b in recs]
        if attempt == 1:
            buf = io.StringIO()
            csv.writer(buf).writerows([header] + rows)
            if cf.env("SP_SITE_URL"):
                arch = cf.SharePoint.from_env("SP_SITE_URL", "SP_LIBRARY")
                folder = report.get("ARCHIVE_FOLDER")
                arch.ensure_folder(folder)
                name = f"{report.file_prefix}_{day.isoformat()}.csv"
                for ext in (".csv", ".xlsx", ".xls"):      # never overwrite a file the old job saved
                    try:
                        arch.download(f"{folder.strip('/')}/{report.file_prefix}_{day.isoformat()}{ext}")
                        raise cf.RunError(f"The archive already has a {ext} file for {day} - nothing changed")
                    except cf.RunError as e:
                        if "already has" in str(e):
                            raise
                arch.upload(f"{folder.strip('/')}/{name}", buf.getvalue().encode("utf-8-sig"))
                log.info("Archived %s in '%s' (%d rows)", name, folder, len(rows))
        master.append(header, rows)
        try:
            sp.upload(path, master.to_bytes(), if_match=etag)
            log.info("Done: %d rows for %s added to the master sheet", len(rows), day)
            return 0
        except cf.UploadConflict:
            log.warning("Master changed while updating (attempt %d); retrying", attempt)
        except cf.FileLocked:
            log.warning("Master is locked (open in Excel desktop?) (attempt %d); waiting 60s", attempt)
            time.sleep(60)
    raise cf.RunError("Could not save the master workbook after 5 attempts.")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except cf.RunError as e:
        log.error("%s", e)
        sys.exit(1)
