#!/usr/bin/env python3
"""
corefactor_to_hub.py - sends the Corefactor call logs (one file per day) to the MIS Upload Hub.

The 07:40 job (corefactor_from_db.py) saves each day's calls as Corefactor_CallLogs_<day>.csv in the SharePoint
"Call Log Archive" folder - the same rows it appends to Backend Call Log Report.xlsx. This script takes those day
files from the archive and sends them to the hub, which passes them on to every MIS that uses call logs
(e.g. the Team Callback MIS), exactly as send_to_hub.py does for the VetBuddy file. So the MIS has calls up to
yesterday. (Older days in the archive may be .xlsx / .xls files from the old Corefactor download; they are sent too.)

Usage:
    python corefactor_to_hub.py                          yesterday
    python corefactor_to_hub.py --from 2026-10-01 --to 2026-11-26     old days, one day per send
Env: SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE_URL, SP_LIBRARY, SP_CALLLOG_ARCHIVE_FOLDER, HUB_URL, HUB_KEY
"""
import argparse
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import corefactor_calllogs_export as cf
import send_to_hub

log = cf.log


def day_file(arch, folder, day):
    """The archived file of the day (csv first, then the old download's xlsx / xls), or None."""
    for ext in (".csv", ".xlsx", ".xls"):
        name = f"{cf.CALL_LOGS.file_prefix}_{day.isoformat()}{ext}"
        try:
            content, _ = arch.download(f"{folder.strip('/')}/{name}")
            return name, content
        except cf.RunError:
            continue
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    a = ap.parse_args()
    cf.setup_logging()
    yesterday = datetime.now(cf.IST).date() - timedelta(days=1)
    start = datetime.strptime(a.start, "%Y-%m-%d").date() if a.start else yesterday
    end = datetime.strptime(a.end, "%Y-%m-%d").date() if a.end else (start if a.start else yesterday)
    if end < start:
        sys.exit("--to is before --from")
    arch = cf.SharePoint.from_env("SP_SITE_URL", "SP_LIBRARY")
    folder = cf.CALL_LOGS.get("ARCHIVE_FOLDER")
    sent, missing, failed = 0, [], []
    with tempfile.TemporaryDirectory() as tmp:
        d = start
        while d <= end:
            got = day_file(arch, folder, d)
            if not got:
                missing.append(d.isoformat())
            else:
                name, content = got
                path = Path(tmp) / name
                path.write_bytes(content)
                log.info("Sending %s (%d KB) to the hub", name, len(content) // 1024)
                try:
                    send_to_hub.main([str(path)])        # exits with an error if the hub reports a problem
                    sent += 1
                except SystemExit as e:
                    log.error("Hub problem for %s: %s", name, e)
                    failed.append(d.isoformat())
            d += timedelta(days=1)
    log.info("Days sent: %d · no file in the archive: %s · hub problems: %s", sent, ", ".join(missing) or "none",
             ", ".join(failed) or "none")
    if failed or (sent == 0 and start == end):
        sys.exit(1)


if __name__ == "__main__":
    main()
