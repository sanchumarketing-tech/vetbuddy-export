#!/usr/bin/env python3
"""
Corefactor Lead Box daily export -> SharePoint master sheet.

Every morning:
  1. Exports the leads CREATED yesterday (IST) from Corefactor Lead Box (All Leads), the same as
     Lead Box -> Filter: Created Date = yesterday -> Export.
  2. Saves the day's file in <library>/Lead Box Archive (created if missing), every day.
  3. Appends the rows under the last row of the master (Backend Leadbox Report.xlsx), matching
     columns by header name, and drags the formula columns "Date" and "Appt Datevalue" down.
     A day already in the master (found by "Date", else "Created Date") is skipped by default;
     --if-present replace rewrites that day when its rows are the last rows of the sheet.

All the shared code (sign-in with the saved session, Export History, SharePoint, the master
sheet) lives in corefactor_calllogs_export.py, which must be in the same folder.

Environment (same secrets as the call logs job):
  COREFACTOR_SESSIONID, SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET
  SP_SITE_URL, SP_LIBRARY             archive location (Sales Reports Sanchu)
  SP_LEADBOX_SITE_URL                 site / OneDrive holding the master
  SP_LEADBOX_LIBRARY                  library there (default "Documents")
  SP_LEADBOX_MASTER_PATH              e.g. "Sanchu Reports/Backend Leadbox Report.xlsx"
  SP_LEADBOX_ARCHIVE_FOLDER           default "Lead Box Archive"
  SP_LEADBOX_SHEET                    worksheet (default: the first sheet)
  SP_LEADBOX_DATE_COLUMN              default "Date"
  SP_LEADBOX_FALLBACK_DATE_COLUMN     default "Created Date"
  SP_LEADBOX_FORMULA_COLUMNS          default "Date,Appt Datevalue"
  SP_LEADBOX_IF_PRESENT               skip (default) | replace | append

Usage:
  python corefactor_leadbox_export.py                      # yesterday (IST)
  python corefactor_leadbox_export.py --date 2026-11-05
  python corefactor_leadbox_export.py --date 2026-11-05 --if-present replace
"""

import sys

from corefactor_calllogs_export import LEAD_BOX, run

if __name__ == "__main__":
    sys.exit(run(LEAD_BOX))
