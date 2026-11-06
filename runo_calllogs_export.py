#!/usr/bin/env python3
"""
Runo call logs -> month-to-date file + master sheet (Sanchu Animal Hospital).

Every morning (GitHub Actions):
  1. Fetches every call from the 1st of the month to yesterday through Runo's API
     (GET https://api.runo.in/v1/call/logs, one day at a time, 100 calls per page).
     On the 1st of a month it takes the whole previous month, so the last day is never missed.
  2. Saves them as Runo_CallLogs_MTD_<from>_to_<to>.xlsx in <library>/Runo Upload
     (created automatically).
  3. Replaces that period's rows in the master (Runo CallLog.xlsx): the month's rows are
     cleared and written again under the last row, columns in the master's order, and the
     drag-down formula columns "Date" and "Month" are filled down. Older months are never touched.

Safety:
  - Before writing, every master header is checked against the new data; any difference stops
    the run with the master unchanged.
  - The month's rows must be the last rows of the master; otherwise the run stops unchanged.
  - If the API returns noticeably fewer calls than the master already holds for the period
    (less than 90%), the run stops unchanged (use --force to write anyway).
  - The master is saved only if nobody changed it meanwhile; if it is open (locked), the run
    retries every minute.

Shared code (SharePoint, master sheet) lives in corefactor_calllogs_export.py (same folder).

Environment:
  RUNO_API_KEY            (secret) API key from Runo -> API Configuration
  RUNO_PROCESS            optional process name (default: all processes)
  SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET   (secrets) same Azure app as the other jobs
  SP_SITE_URL, SP_LIBRARY  where Runo Upload lives (Sales Reports Sanchu, next to CRM Upload)
  SP_RUNO_UPLOAD_FOLDER   default "Runo Upload"
  SP_RUNO_SITE_URL        site / OneDrive holding the master
  SP_RUNO_LIBRARY         library there (default "Documents")
  SP_RUNO_MASTER_PATH     e.g. "Sanchu Reports/Runo CallLog.xlsx"
  SP_RUNO_SHEET           worksheet (default: the first sheet)
  OUTPUT_DIR              local folder for the file (default ./reports)

Usage:
  python runo_calllogs_export.py                                  # month to date (yesterday)
  python runo_calllogs_export.py --from 2026-10-01 --to 2026-10-31 # a past period
  python runo_calllogs_export.py --file-only                      # no master update
"""

import argparse
import io
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

from corefactor_calllogs_export import (IST, FileLocked, Master, Report, RunError, SharePoint,
                                        UploadConflict, env, log, setup_logging)

API = "https://api.runo.in/v1"
PAGE_SIZE = 100            # fixed by Runo

# The master's data columns, in its order (Date and Month are drag-down formulas).
COLUMNS = ["Customer Id", "Crm Interaction Id", "Name", "Phone", "Call Start Date", "Call Type",
           "Call Tag", "Duration (in Sec)", "Duration", "Caller Name", "Status"]

RUNO = Report("Runo call logs", "SP_RUNO", "runo", "Runo_CallLogs",
              fallback_date="Call Start Date", formula_columns="Date,Month",
              archive_folder="Runo Upload")


# ----------------------------------------------------------------------------- Runo API

class Runo:
    def __init__(self, api_key, process=None):
        self.s = requests.Session()
        self.s.headers.update({"Auth-Key": api_key, "Accept": "application/json"})
        self.process = process

    def _get(self, path, params):
        for attempt in range(1, 6):
            try:
                r = self.s.get(API + path, params=params, timeout=60)
            except requests.RequestException as exc:
                log.warning("Runo request failed (%s), attempt %d/5", exc, attempt)
                time.sleep(5 * attempt)
                continue
            if r.status_code == 403:
                try:
                    msg = r.json().get("message")
                except ValueError:
                    msg = r.text[:200]
                raise RunError(f"Runo refused the API key ({msg}). Check the RUNO_API_KEY secret "
                               f"against Runo -> API Configuration.")
            if r.status_code == 429 or r.status_code >= 500:
                log.warning("Runo returned HTTP %d, retrying (attempt %d/5)", r.status_code, attempt)
                time.sleep(10 * attempt)
                continue
            if r.status_code != 200:
                raise RunError(f"Runo returned HTTP {r.status_code} for {path}: {r.text[:300]}")
            body = r.json()
            if body.get("statusCode") == -1:
                raise RunError(f"Runo refused the API key ({body.get('message')}). Check the "
                               f"RUNO_API_KEY secret against Runo -> API Configuration.")
            if body.get("statusCode") != 0:
                raise RunError(f"Runo error for {path} {params}: {body.get('message')}")
            return body.get("data") or {}
        raise RunError(f"Runo did not answer after 5 attempts ({path} {params}).")

    def calls_of_day(self, day):
        """All call logs of one (past) day, every page."""
        calls, page, total = [], 1, None
        while True:
            params = {"date": day.isoformat(), "pageNo": page}
            if self.process:
                params["processName"] = self.process
            data = self._get("/call/logs", params)
            rows = data.get("data") or []
            meta = data.get("metadata") or []
            if total is None and meta and isinstance(meta, list):
                total = meta[0].get("total")
            calls.extend(rows)
            if not rows or len(rows) < PAGE_SIZE or (total is not None and len(calls) >= total):
                break
            page += 1
            if page > 2000:
                raise RunError(f"More than 2000 pages for {day} - stopping to be safe.")
        if total is not None and len(calls) < total:
            log.warning("%s: Runo reported %d calls but returned %d", day, total, len(calls))
        return calls


# ----------------------------------------------------------------------------- rows

def hms(seconds):
    seconds = int(seconds or 0)
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def to_row(c):
    start = c.get("startTime") or c.get("createdAt")
    start_dt = datetime.fromtimestamp(int(start), IST).replace(tzinfo=None) if start else None
    secs = int(c.get("duration") or 0)
    return [
        c.get("customerId"),
        c.get("callId"),
        c.get("name"),
        c.get("phoneNumber"),
        start_dt,
        c.get("type"),
        c.get("tag"),
        secs,
        hms(secs),
        c.get("calledBy"),
        c.get("status"),
    ]


def fetch_period(runo, first, last):
    rows, seen, day = [], set(), first
    while day <= last:
        calls = runo.calls_of_day(day)
        added = 0
        for c in calls:
            key = c.get("callId") or (c.get("callerId"), c.get("startTime"), c.get("phoneNumber"))
            if key in seen:
                continue
            seen.add(key)
            rows.append(to_row(c))
            added += 1
        log.info("%s: %d calls", day, added)
        day += timedelta(days=1)
    rows.sort(key=lambda r: r[4] or datetime.min)
    return rows


def write_xlsx(rows, path):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Call Logs"
    ws.append(COLUMNS)
    for r in rows:
        ws.append(r)
    for cell in ws["E"][1:]:
        cell.number_format = "dd-mm-yyyy hh:mm:ss"
    wb.save(path)


# ----------------------------------------------------------------------------- master

def update_master(sp, path, first, last, rows, force):
    for attempt in range(1, 31):
        wb_bytes, etag = sp.download(path)
        master = Master(wb_bytes, RUNO)
        removed = master.remove_period(first, last)
        if removed and len(rows) < 0.9 * removed and not force:
            raise RunError(f"Runo returned {len(rows)} calls for {first} to {last}, but the master "
                           f"already holds {removed} for that period. Stopping so no data is lost - "
                           f"master NOT changed (re-run with --force if this is expected).")
        master.append(COLUMNS, rows)
        try:
            sp.upload(path, master.to_bytes(), if_match=etag)
            log.info("Master: replaced %d rows of %s to %s with %d rows", removed, first, last, len(rows))
            return
        except UploadConflict:
            log.warning("Master changed while updating (attempt %d); retrying with the latest copy", attempt)
        except FileLocked:
            log.warning("Master is open/locked by someone (attempt %d/30); retrying in 60s", attempt)
            time.sleep(60)
    raise RunError("Could not save the master (it stayed open or kept changing for 30 minutes). "
                   "Close it and re-run.")


# ----------------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description="Runo call logs -> MTD file + master sheet")
    ap.add_argument("--from", dest="d_from", help="first day, YYYY-MM-DD (default: 1st of yesterday's month)")
    ap.add_argument("--to", dest="d_to", help="last day, YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--file-only", action="store_true", help="save/upload the file, don't touch the master")
    ap.add_argument("--force", action="store_true", help="write even if Runo returns fewer calls than the master has")
    args = ap.parse_args(argv)
    setup_logging()

    try:
        yesterday = datetime.now(IST).date() - timedelta(days=1)
        last = date.fromisoformat(args.d_to) if args.d_to else yesterday
        first = date.fromisoformat(args.d_from) if args.d_from else last.replace(day=1)
        if last >= datetime.now(IST).date():
            raise RunError("Runo only gives past days: --to must be yesterday or earlier.")
        if first > last:
            raise RunError("--from is after --to.")
        log.info("Runo call logs %s to %s", first, last)

        runo = Runo(env("RUNO_API_KEY", required=True), env("RUNO_PROCESS"))
        rows = fetch_period(runo, first, last)
        log.info("Fetched %d calls in total", len(rows))
        if not rows:
            log.warning("No calls returned for %s to %s - nothing uploaded, master not changed", first, last)
            return 0

        out_dir = Path(env("OUTPUT_DIR", "reports"))
        out_dir.mkdir(parents=True, exist_ok=True)
        local = out_dir / f"Runo_CallLogs_MTD_{first.isoformat()}_to_{last.isoformat()}.xlsx"
        write_xlsx(rows, local)
        log.info("Saved %s (%d rows)", local.name, len(rows))

        if env("SP_SITE_URL"):
            up = SharePoint.from_env("SP_SITE_URL", "SP_LIBRARY")
            folder = env("SP_RUNO_UPLOAD_FOLDER", "Runo Upload")
            up.ensure_folder(folder)
            up.upload(f"{folder.strip('/')}/{local.name}", local.read_bytes())
            log.info("Uploaded to SharePoint: %s/%s", folder, local.name)

        if not args.file_only:
            sp = SharePoint.from_env("SP_RUNO_SITE_URL", "SP_RUNO_LIBRARY")
            update_master(sp, RUNO.get("MASTER_PATH", required=True), first, last, rows, args.force)
            log.info("Done: master updated with %d calls (%s to %s)", len(rows), first, last)
        return 0
    except RunError as exc:
        log.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
