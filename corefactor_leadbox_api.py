#!/usr/bin/env python3
"""
Corefactor Lead Box daily, through Corefactor's Lead API (API key) -> SharePoint master sheet.
Replaces the session-id export (corefactor_leadbox_export.py); same results:
  1. the leads CREATED yesterday (IST) are fetched from https://tw1.teleduce.corefactors.in/lead/retrieval/
     (header API-KEY, JSON body: created_at_range, page, record_size; 100 leads a page);
  2. the day's file is saved in the archive folder as Corefactor_LeadBox_<day>.csv (read by the Call Desk load);
  3. the rows are appended to Backend Leadbox Report.xlsx in the master's column order, and the formula columns
     ("Date", "Appt Datevalue") are dragged down. A day already in the master is skipped (--if-present replace
     rewrites it when its rows are the last rows).
API field -> master column: same names, plus ID -> Unique ID, created_at -> Created Date, modified_at -> Modified Date.
Master columns the API does not have stay blank (Lead Revenue Currency Code, Converted Date, Score, Location ...).

Usage: python corefactor_leadbox_api.py [--date YYYY-MM-DD] [--if-present skip|replace] [--check]
       --check: fetch and compare only, change nothing.
Env:   COREFACTOR_LEADBOX_API_KEY, COREFACTOR_BASE_URL (default https://tw1.teleduce.corefactors.in),
       SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE_URL, SP_LIBRARY (archive),
       SP_LEADBOX_SITE_URL, SP_LEADBOX_LIBRARY, SP_LEADBOX_MASTER_PATH, SP_LEADBOX_ARCHIVE_FOLDER
"""
import argparse
import csv
import io
import sys
import time
from datetime import datetime, timedelta

import requests

import corefactor_calllogs_export as cf

log = cf.log
RENAME = {"uniqueid": "ID", "createddate": "created_at", "modifieddate": "modified_at"}


def fetch(day):
    """All leads created on `day` (IST). The API's range filter is not in IST, so ask for the days around it
    and keep the leads whose created_at (IST) is that day."""
    base = cf.env("COREFACTOR_BASE_URL", "https://tw1.teleduce.corefactors.in").rstrip("/")
    key = cf.env("COREFACTOR_LEADBOX_API_KEY", required=True).strip()
    rng = f"{day - timedelta(days=1)},{day + timedelta(days=1)}"
    out, page = [], 1
    while True:
        for attempt in range(1, 4):
            try:
                r = requests.get(f"{base}/lead/retrieval/", timeout=120,
                                 headers={"API-KEY": key, "Content-Type": "application/json"},
                                 json={"created_at_range": rng, "page": page, "record_size": 100})
                j = r.json()
                break
            except (requests.RequestException, ValueError) as e:
                if attempt == 3:
                    raise cf.RunError(f"Lead API not reachable: {e}")
                time.sleep(10 * attempt)
        code = str(j.get("response_code"))
        if code == "7008":                     # no more leads
            break
        if code != "7000":
            raise cf.RunError(f"Lead API answered {code}: {j.get('reponse') or j.get('response')}")
        batch = j.get("response") or []
        out += batch
        if not j.get("is_more_leads_available") or not batch:
            break
        page += 1
        time.sleep(0.3)
    leads = {}
    for l in out:
        if str(l.get("created_at") or "")[:10] == day.isoformat():
            leads[l.get("ID")] = l             # a lead on two pages counts once
    log.info("Lead API: %d leads fetched over %s, %d created on %s", len(out), rng, len(leads), day)
    return list(leads.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--if-present", choices=["skip", "replace"], default=cf.LEAD_BOX.get("IF_PRESENT") or "skip")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    cf.setup_logging()
    report = cf.LEAD_BOX
    day = (datetime.strptime(args.date, "%Y-%m-%d").date() if args.date
           else datetime.now(cf.IST).date() - timedelta(days=1))
    log.info("Corefactor Lead Box for %s, through the Lead API", day)
    leads = fetch(day)
    if not leads:
        log.warning("No leads created on %s - nothing changed", day)
        return 0

    sp = cf.SharePoint.from_env("SP_LEADBOX_SITE_URL", "SP_LEADBOX_LIBRARY")
    path = report.get("MASTER_PATH", required=True)
    for attempt in range(1, 6):
        wb_bytes, etag = sp.download(path)
        master = cf.Master(wb_bytes, report)
        formula = {ci for ci in master.headers
                   for r in range(master.last, max(master.hr, master.last - 500), -1)
                   if isinstance(master.ws.cell(r, ci).value, str) and str(master.ws.cell(r, ci).value).startswith("=")}
        header = [str(master.headers[ci]).strip() for ci in sorted(master.headers) if ci not in formula]
        api = {cf.norm(k): k for k in leads[0]}
        cols = [api.get(cf.norm(h)) or (RENAME.get(cf.norm(h)) if RENAME.get(cf.norm(h)) in leads[0] else None)
                for h in header]
        blank = [h for h, c in zip(header, cols) if c is None]
        if attempt == 1:
            log.info("Master columns with no API field (left blank): %s", ", ".join(blank) or "none")
        rows = [[l.get(c) if c else None for c in cols] for l in sorted(leads, key=lambda x: str(x.get("created_at")))]
        present = master.has_day(day)
        if args.check:
            n = sum(1 for r in range(master.hr + 1, master.last + 1) if master.row_day(r) == day)
            log.info("CHECK ONLY: API %d leads for %s; master has %d rows for that day. Nothing changed.", len(rows), day, n)
            return 0
        if present:
            if args.if_present == "skip":
                log.info("The master already has %s - left unchanged", day)
                return 0
            master.remove_day(day)
        if attempt == 1:
            buf = io.StringIO()
            csv.writer(buf).writerows([header] + rows)
            if cf.env("SP_SITE_URL"):
                arch = cf.SharePoint.from_env("SP_SITE_URL", "SP_LIBRARY")
                folder = report.get("ARCHIVE_FOLDER")
                arch.ensure_folder(folder)
                name = f"{report.file_prefix}_{day.isoformat()}.csv"
                arch.upload(f"{folder.strip('/')}/{name}", buf.getvalue().encode("utf-8-sig"))
                log.info("Archived %s in '%s'", name, folder)
        master.append(header, rows)
        try:
            sp.upload(path, master.to_bytes(), if_match=etag)
            log.info("Done: %d leads for %s added to the master sheet", len(rows), day)
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
