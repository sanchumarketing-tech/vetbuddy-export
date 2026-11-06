#!/usr/bin/env python3
"""
Corefactor (Teleduce) daily call-log export -> SharePoint master sheet.

This file also holds the code shared with corefactor_leadbox_export.py (Lead Box), which uses
the same steps with SP_LEADBOX_* settings.

What it does
  1. Uses a saved Corefactor browser session to request a Call Logs export for one day
     (yesterday in IST by default). This is the same request the "Export" button sends.
  2. Waits for the file to appear in Export History, downloads the zip and unzips it.
  3. Keeps a copy in OUTPUT_DIR (and, optionally, in a SharePoint folder).
  4. Appends the rows to the master workbook on SharePoint, matching columns by header
     name. Each new row copies the formatting and value types of the last existing row, and
     any formula column (like the drag-down "Date" column) is filled down from the row above.
     The day of each row is read from the drag-down "Date" column (falling back to "Call Date").
     If the day is already there, it is skipped by default; "replace" clears that day's rows and
     writes them again (only when they are the last rows of the sheet).
  5. Saves a copy of each day's export in an archive folder, every day, even when the master
     already had that day.

Sign-in
  Corefactor's sign-in page has a CAPTCHA, so this script never logs in. It reuses the
  "sessionid" cookie from a browser where someone is signed in. When that session expires,
  the run fails with a clear message: sign in to Corefactor in a browser, copy the new
  sessionid cookie and update the COREFACTOR_SESSIONID secret.

Environment
  COREFACTOR_SESSIONID     (secret, required) value of the "sessionid" cookie
  COREFACTOR_BASE_URL      default https://tw1.teleduce.corefactors.in
  OUTPUT_DIR               where the downloaded file is kept (default ./reports)

  SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET   (secrets) same Azure app as the VetBuddy job

  Master sheet (Backend Call Log Report):
  SP_CALLLOG_SITE_URL      site or personal OneDrive holding the master, e.g.
                           https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in
  SP_CALLLOG_LIBRARY       library on that site (default "Documents")
  SP_CALLLOG_MASTER_PATH   master workbook path inside the library, e.g. "Sanchu Reports/Backend Call Log Report.xlsx"
  SP_CALLLOG_SHEET         worksheet to append to (default: the first sheet)
  SP_CALLLOG_HEADER_ROW    row that holds the column headers (default 1)
  SP_CALLLOG_DATE_COLUMN   drag-down date column used to find a day's rows (default "Date")
  SP_CALLLOG_FALLBACK_DATE_COLUMN  used when "Date" has no stored result (default "Call Date")
  SP_CALLLOG_IF_PRESENT    skip (default) | replace | append, when the day is already in the master

  Daily archive copy (same site/library as the VetBuddy CRM Upload folder):
  SP_SITE_URL              e.g. https://sanchuhospital.sharepoint.com/sites/SalesTeam
  SP_LIBRARY               e.g. "Sales Reports Sanchu"
  SP_CALLLOG_ARCHIVE_FOLDER  folder in that library (default "Call Log Archive"; created if missing)
  SP_CALLLOG_FORMULA_COLUMNS  formula columns that must be dragged down (default "Date");
                           the run stops rather than add rows without them

Usage
  python corefactor_calllogs_export.py                       # yesterday (IST)
  python corefactor_calllogs_export.py --date 2026-11-05     # a specific day
  python corefactor_calllogs_export.py --date 2026-11-05 --if-present replace
  python corefactor_calllogs_export.py --download-only       # no SharePoint at all

Note: the master workbook is opened and saved with openpyxl (as in the VetBuddy job).
openpyxl keeps data, formulas, styles and tables, but drops charts, images and slicers.
Keep those in a separate workbook that reads from the master.
"""

import argparse
import csv
import io
import json
import logging
import os
import re
import sys
import time
import zipfile
from copy import copy
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import requests

IST = timezone(timedelta(hours=5, minutes=30))
LOG_FILE = "corefactor_export.log"
DEBUG_HTML = "corefactor_debug.html"
GRAPH = "https://graph.microsoft.com/v1.0"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

log = logging.getLogger("corefactor")


class RunError(Exception):
    """A failure with a message meant for the person reading the log."""


class AlreadyPresent(Exception):
    """The master sheet already has rows for this date."""


class UploadConflict(Exception):
    """The master workbook changed between download and upload."""


class FileLocked(Exception):
    """The master workbook is locked (usually open in Excel desktop)."""


# ----------------------------------------------------------------------------- helpers

def setup_logging():
    if log.handlers:
        return
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    log.setLevel(logging.INFO)
    for handler in (logging.StreamHandler(sys.stdout),
                    logging.FileHandler(LOG_FILE, encoding="utf-8")):
        handler.setFormatter(fmt)
        log.addHandler(handler)


def env(name, default=None, required=False):
    value = os.environ.get(name, "").strip()
    if not value:
        if required:
            raise RunError(f"Missing environment variable {name}")
        return default
    return value


def save_debug(html):
    Path(DEBUG_HTML).write_text(html or "", encoding="utf-8")
    log.info("Saved the page Corefactor returned to %s for diagnosis", DEBUG_HTML)


def norm(header):
    """Normalise a header for matching: 'Call  Duration ' -> 'callduration'."""
    return re.sub(r"[^a-z0-9]", "", str(header or "").lower())


DATE_FORMATS = [
    "%d-%m-%Y %I:%M:%S %p", "%d-%m-%Y %I:%M %p", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d-%m-%Y",
    "%d/%m/%Y %I:%M:%S %p", "%d/%m/%Y %I:%M %p", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %I:%M:%S %p", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d",
]


def parse_dt(value):
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value).strip())
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    return None


def parse_time(value):
    if isinstance(value, dtime):
        return value
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", str(value).strip())
    if not m or int(m.group(1)) > 23:
        return None
    return dtime(int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


def as_date(value):
    """A cell value (date, datetime, Excel serial number or text) as a date, or None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        if 20000 < value < 80000:                       # an Excel date serial number
            return (datetime(1899, 12, 30) + timedelta(days=float(value))).date()
        return None
    if isinstance(value, str) and value.startswith("="):
        return None
    d = parse_dt(value)
    return d.date() if d else None


NUMBER_RE = re.compile(r"-?\d+(\.\d+)?")


def convert_like(value, sample):
    """Convert an exported value to the same kind of value as the master's last row."""
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if value == "":
            return None
    if isinstance(sample, datetime):
        return parse_dt(value) or value
    if isinstance(sample, dtime):
        return parse_time(value) or value
    if isinstance(sample, (int, float)) and not isinstance(sample, bool) and isinstance(value, str):
        plain = value.replace(",", "")
        if NUMBER_RE.fullmatch(plain):
            number = float(plain)
            return int(number) if number.is_integer() and "." not in plain else number
    return value


# ----------------------------------------------------------------------------- report settings

class Report:
    """What differs between the Corefactor reports. Settings are read from environment
    variables named <prefix>_<NAME>, e.g. SP_CALLLOG_MASTER_PATH or SP_LEADBOX_MASTER_PATH."""

    def __init__(self, title, prefix, export, file_prefix, fallback_date, formula_columns,
                 archive_folder, drop_columns="", date_column="Date"):
        self.title = title                  # for the log, e.g. "call logs"
        self.prefix = prefix                # environment variable prefix
        self.export = export                # "calllogs" or "leadbox": which export request to send
        self.file_prefix = file_prefix      # name of the saved/archived file
        self.defaults = {
            "DATE_COLUMN": date_column,                 # drag-down date column used to find a day
            "FALLBACK_DATE_COLUMN": fallback_date,      # used when that formula has no stored result
            "FORMULA_COLUMNS": formula_columns,         # must be dragged down on every new row
            "ARCHIVE_FOLDER": archive_folder,
            "LIBRARY": "Documents",
            "HEADER_ROW": "1",
            "IF_PRESENT": "skip",
            # export columns removed before pasting, as done by hand: letter ranges and/or "last N"
            "DROP_COLUMNS": drop_columns,
        }

    def get(self, name, required=False):
        return env(f"{self.prefix}_{name}", self.defaults.get(name), required)


CALL_LOGS = Report("call logs", "SP_CALLLOG", "calllogs", "Corefactor_CallLogs",
                   fallback_date="Call Date", formula_columns="Date", archive_folder="Call Log Archive",
                   drop_columns="last 3")
LEAD_BOX = Report("Lead Box", "SP_LEADBOX", "leadbox", "Corefactor_LeadBox",
                  fallback_date="Created Date", formula_columns="Date,Appt Datevalue",
                  archive_folder="Lead Box Archive", drop_columns="AQ:BG")


# ----------------------------------------------------------------------------- Corefactor

class Corefactor:
    def __init__(self, base_url, sessionid):
        self.base = base_url.rstrip("/")
        host = urlparse(self.base).hostname
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": USER_AGENT})
        self.s.cookies.set("sessionid", sessionid, domain=host, path="/")
        self.csrf = None

    def _check(self, resp):
        if urlparse(resp.url).path.startswith("/signin") or resp.status_code in (401, 403):
            save_debug(resp.text)
            raise RunError(
                "Corefactor session has expired (it sent us to the sign-in page). Sign in to "
                "Corefactor in a browser, copy the new 'sessionid' cookie and update the "
                "COREFACTOR_SESSIONID secret, then re-run this workflow.")
        if resp.status_code >= 400:
            save_debug(resp.text)
            raise RunError(f"Corefactor returned HTTP {resp.status_code} for {resp.url}")

    def open_call_logs(self):
        resp = self.s.get(self.base + "/calllist/reports/", timeout=90)
        self._check(resp)
        m = re.search(r"csrfmiddlewaretoken[\"']?\s*(?:value=|:)\s*[\"']([A-Za-z0-9]{20,})", resp.text)
        self.csrf = m.group(1) if m else self.s.cookies.get("csrftoken")
        if not self.csrf:
            save_debug(resp.text)
            raise RunError("Could not find Corefactor's form token on the Call Logs page.")
        log.info("Signed in to Corefactor (session is valid)")

    def request_export(self, day, file_name):
        d = day.isoformat()
        data = {
            "csrfmiddlewaretoken": self.csrf,
            "saved_filter": "{'customer_id':'customer.id'}",   # "All Calls"
            "filter": "",
            "start_date": d,
            "end_date": d,
            "daterange": f"{d},{d}",
            "call_logs_export_file_name": file_name,
        }
        headers = {
            "Referer": self.base + "/calllist/reports/",
            "Origin": self.base,
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRFToken": self.csrf,
        }
        resp = self.s.post(self.base + "/calllist/export_csv/", data=data, headers=headers, timeout=120)
        self._check(resp)
        try:
            body = json.loads(resp.text)
            if isinstance(body, str):
                body = json.loads(body)
        except ValueError:
            save_debug(resp.text)
            raise RunError("Corefactor did not accept the export request (unexpected response).")
        if body.get("response_type") != "success":
            raise RunError(f"Corefactor refused the export request: {body}")
        log.info("Requested Call Logs export for %s as '%s'", d, file_name)

    def request_leadbox_export(self, day, file_name):
        """Same as Lead Box -> Filter: Created Date = day -> Export (All Leads)."""
        d = day.isoformat()
        data = {
            "exp": "exp",
            "filter": json.dumps({"created_at__gt": f"{d} 00:00:00", "created_at__lte": f"{d} 23:59:59"},
                                 separators=(",", ":")),
            "saved_filter": "{'customer_id':'customer.id','data_value':'True'}",   # "All Leads"
            "report": "",
            "category": "",
            "reportrange": "",
            "searchkey": "",
            "date_field": "created",
            "export_file_name": file_name,
            "csrfmiddlewaretoken": self.csrf,
            "with_telephony_insights": "false",
            "with_flexilog": "false",
            "flexilog_dropdown": "",
        }
        headers = {
            "Referer": self.base + "/lead_manager/",
            "Origin": self.base,
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRFToken": self.csrf,
        }
        resp = self.s.post(self.base + "/lead-export/", data=data, headers=headers, timeout=120)
        self._check(resp)
        try:
            body = json.loads(resp.text)
            if isinstance(body, str):
                body = json.loads(body)
        except ValueError:
            save_debug(resp.text)
            raise RunError("Corefactor did not accept the Lead Box export request (unexpected response).")
        if body.get("error_type") != "success":
            raise RunError(f"Corefactor refused the Lead Box export request: {body}")
        log.info("Requested Lead Box export (created on %s) as '%s'", d, file_name)

    def wait_for_export(self, file_name, timeout_s, poll_s=20):
        """Poll Export History until our file is ready and return its download URL.

        The Export History page loads its rows with a POST to /export-history/ that returns
        JSON ({"datas": "<JSON list>"}); each record has fields.file_name and fields.ui_link
        (empty while processing, "FAILED", "expired", or the id used in /export-data/<id>/)."""
        deadline = time.time() + timeout_s
        today = datetime.now(IST).date()
        data = {
            "dt": "dtdesc", "start_index": "0", "end_index": "50", "app_sort": "", "records": "100",
            "datewise": f"{(today - timedelta(days=1)).isoformat()},{today.isoformat()}",
            "arrayvl": "", "resive": "gettabledata", "csrfmiddlewaretoken": self.csrf,
        }
        headers = {"Referer": self.base + "/export-history/", "Origin": self.base,
                   "X-Requested-With": "XMLHttpRequest", "X-CSRFToken": self.csrf}
        last_state = "not listed yet"
        while True:
            resp = self.s.post(self.base + "/export-history/", data=data, headers=headers, timeout=90)
            self._check(resp)
            try:
                payload = resp.json()
                records = json.loads(payload["datas"]) if isinstance(payload.get("datas"), str) \
                    else payload.get("datas") or []
            except (ValueError, KeyError, TypeError):
                save_debug(resp.text)
                raise RunError("Export History returned something unexpected (see corefactor_debug.html).")
            mine = [r.get("fields", {}) for r in records
                    if (r.get("fields", {}).get("file_name") or "").strip() == file_name]
            if mine:
                link = (mine[0].get("ui_link") or "").strip()
                if link == "FAILED":
                    raise RunError(f"Corefactor reports the export '{file_name}' FAILED. Re-run the workflow.")
                if link and link != "expired":
                    log.info("Export is ready in Export History")
                    return f"{self.base}/export-data/{link}/"
                last_state = "still processing"
            if time.time() > deadline:
                save_debug(resp.text)
                raise RunError(f"The export '{file_name}' was not ready in Export History within "
                               f"{timeout_s // 60} minutes ({last_state}).")
            time.sleep(poll_s)

    def download(self, url):
        resp = self.s.get(url, timeout=600, allow_redirects=True)
        self._check(resp)
        if not resp.content.startswith(b"PK"):
            save_debug(resp.text)
            raise RunError("The downloaded export is not a zip file.")
        log.info("Downloaded export zip (%.1f KB)", len(resp.content) / 1024)
        return resp.content


def read_export(zip_bytes):
    """Return (file name, raw bytes, header list, data rows) of the file inside the zip."""
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    members = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX")]
    if not members:
        raise RunError("The export zip is empty.")
    name = max(members, key=lambda n: z.getinfo(n).file_size)
    raw = z.read(name)
    ext = Path(name).suffix.lower()

    if ext in (".csv", ".txt"):
        text = raw.decode("utf-8-sig", errors="replace")
        rows = [list(r) for r in csv.reader(io.StringIO(text))]
    elif ext in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        rows = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
    elif ext == ".xls":
        import xlrd
        book = xlrd.open_workbook(file_contents=raw)
        sheet = book.sheet_by_index(0)
        rows = [sheet.row_values(i) for i in range(sheet.nrows)]
    else:
        raise RunError(f"Unexpected file in the export zip: {name}")

    rows = [r for r in rows if any(c not in (None, "") for c in r)]
    if not rows:
        raise RunError(f"{name} has no header row.")
    header = [str(h).strip() if h is not None else "" for h in rows[0]]
    log.info("Export file %s: %d columns, %d rows", name, len(header), len(rows) - 1)
    return name, raw, header, rows[1:]


def col_index(letters):
    """'A' -> 0, 'AQ' -> 42."""
    n = 0
    for ch in letters.strip().upper():
        if not "A" <= ch <= "Z":
            raise RunError(f"Bad column letter '{letters}' in the DROP_COLUMNS setting")
        n = n * 26 + ord(ch) - 64
    return n - 1


def drop_columns(header, rows, spec):
    """Remove export columns before pasting, the same as deleting them by hand.
    spec: comma-separated column letters/ranges of the DOWNLOADED file and/or "last N",
    e.g. "AQ:BG, last 3". All positions refer to the file as downloaded."""
    if not spec or not spec.strip():
        return header, rows
    width = len(header)
    drop = set()
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        m = re.fullmatch(r"last\s*:?\s*(\d+)", part, flags=re.I)
        if m:
            drop.update(range(max(0, width - int(m.group(1))), width))
            continue
        a, _, b = part.partition(":")
        lo, hi = col_index(a), col_index(b or a)
        if hi >= width:
            raise RunError(f"The export has only {width} columns, so '{part}' can't be removed - "
                           f"Corefactor may have changed the export. Nothing was added.")
        drop.update(range(min(lo, hi), max(lo, hi) + 1))
    keep = [i for i in range(width) if i not in drop]
    log.info("Removed %d export columns (%s): %s", len(drop), spec,
             [header[i] for i in sorted(drop)])
    return [header[i] for i in keep], [[r[i] if i < len(r) else None for i in keep] for r in rows]


# ----------------------------------------------------------------------------- SharePoint

class SharePoint:
    def __init__(self, tenant, client_id, secret, site_url, library):
        resp = requests.post(
            f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
            data={"client_id": client_id, "client_secret": secret,
                  "scope": "https://graph.microsoft.com/.default", "grant_type": "client_credentials"},
            timeout=60)
        if resp.status_code != 200:
            raise RunError(f"Could not sign in to Microsoft Graph: {resp.text[:300]}")
        self.h = {"Authorization": "Bearer " + resp.json()["access_token"]}

        u = urlparse(site_url)
        site = self._get(f"{GRAPH}/sites/{u.hostname}:{u.path.rstrip('/') or '/'}").json()
        drives = self._get(f"{GRAPH}/sites/{site['id']}/drives").json()["value"]
        wanted = {library.lower(), "shared documents" if library.lower() == "documents" else library.lower()}

        def url_name(d):   # the library's name as it appears in its address, e.g. "Sales Reports Sanchu"
            return unquote(d.get("webUrl", "")).rstrip("/").split("/")[-1].lower()

        drive = next((d for d in drives if d["name"].lower() in wanted or url_name(d) in wanted), None)
        if not drive and "/personal/" in u.path:
            # A personal OneDrive has one main drive whose name varies ("OneDrive", "Documents").
            drive = self._get(f"{GRAPH}/sites/{site['id']}/drive").json()
        if not drive:
            raise RunError(f"Library '{library}' not found on {site_url}. "
                           f"Libraries: {[d['name'] for d in drives]}")
        log.info("Connected to SharePoint library '%s' on %s", drive.get("name"), site_url)
        self.drive = drive["id"]

    @classmethod
    def from_env(cls, site_var="SP_SITE_URL", library_var="SP_LIBRARY"):
        return cls(env("SP_TENANT_ID", required=True), env("SP_CLIENT_ID", required=True),
                   env("SP_CLIENT_SECRET", required=True), env(site_var, required=True),
                   env(library_var, "Documents"))

    def _get(self, url, **kw):
        resp = requests.get(url, headers=self.h, timeout=120, **kw)
        if resp.status_code >= 400:
            raise RunError(f"SharePoint request failed ({resp.status_code}): {url}\n{resp.text[:300]}")
        return resp

    def _item(self, path):
        return f"{GRAPH}/drives/{self.drive}/root:/{quote(path.strip('/'), safe='/')}"

    def ensure_folder(self, path):
        """Create a folder (and any missing parents) inside the library."""
        parent = ""
        for part in [p for p in path.strip("/").split("/") if p]:
            current = f"{parent}/{part}" if parent else part
            resp = requests.get(self._item(current), headers=self.h, timeout=60)
            if resp.status_code == 404:
                url = (f"{GRAPH}/drives/{self.drive}/root/children" if not parent
                       else self._item(parent) + ":/children")
                made = requests.post(url, headers=self.h, timeout=60, json={
                    "name": part, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})
                if made.status_code not in (200, 201, 409):
                    raise RunError(f"Could not create folder '{current}': {made.text[:300]}")
                log.info("Created folder '%s'", current)
            elif resp.status_code >= 400:
                raise RunError(f"Could not check folder '{current}': {resp.text[:300]}")
            parent = current

    def download(self, path):
        meta = self._get(self._item(path)).json()
        content = self._get(self._item(path) + ":/content").content
        return content, meta.get("eTag")

    def upload(self, path, data, if_match=None):
        headers = dict(self.h)
        if if_match:
            headers["If-Match"] = if_match
        resp = requests.post(self._item(path) + ":/createUploadSession", headers=headers,
                             json={"item": {"@microsoft.graph.conflictBehavior": "replace"}}, timeout=60)
        self._raise_upload(resp)
        upload_url = resp.json()["uploadUrl"]
        size, chunk = len(data), 320 * 1024 * 16          # 5 MB, a multiple of 320 KiB
        for start in range(0, size, chunk):
            end = min(start + chunk, size) - 1
            part = requests.put(upload_url, data=data[start:end + 1], timeout=300, headers={
                "Content-Length": str(end - start + 1),
                "Content-Range": f"bytes {start}-{end}/{size}"})
            self._raise_upload(part)

    @staticmethod
    def _raise_upload(resp):
        if resp.status_code == 412:
            raise UploadConflict()
        if resp.status_code == 423:
            raise FileLocked()
        if resp.status_code >= 400:
            raise RunError(f"SharePoint upload failed ({resp.status_code}): {resp.text[:300]}")


# ----------------------------------------------------------------------------- master sheet

class Master:
    def __init__(self, wb_bytes, report=None):
        from openpyxl import load_workbook
        self.report = report = report or CALL_LOGS
        self.wb = load_workbook(io.BytesIO(wb_bytes))
        sheet = report.get("SHEET")
        if sheet and sheet not in self.wb.sheetnames:
            raise RunError(f"Sheet '{sheet}' not found in the master. Sheets: {self.wb.sheetnames}")
        self.ws = self.wb[sheet] if sheet else self.wb.worksheets[0]
        self.hr = int(report.get("HEADER_ROW"))
        self.headers = {ci: c.value for ci, c in enumerate(self.ws[self.hr], start=1)
                        if c.value not in (None, "")}
        if not self.headers:
            raise RunError(f"Row {self.hr} of sheet '{self.ws.title}' has no headers.")
        # The day of each row comes from the drag-down "Date" column. Because it is a formula, its
        # result is only stored in the file after Excel has recalculated it, so when it is missing
        # the fallback column ("Call Date" / "Created Date") is used instead.
        date_name, fallback_name = report.get("DATE_COLUMN"), report.get("FALLBACK_DATE_COLUMN")
        self.date_col = self._col(date_name)
        self.call_date_col = self._col(fallback_name)
        if not self.date_col and not self.call_date_col:
            raise RunError(f"Neither a '{date_name}' nor a '{fallback_name}' column was found in the master sheet.")
        cached = load_workbook(io.BytesIO(wb_bytes), data_only=True, read_only=True)
        cws = cached[self.ws.title]
        self.cached_dates = {}
        if self.date_col:
            for r, (v,) in enumerate(cws.iter_rows(min_row=self.hr + 1, min_col=self.date_col,
                                                    max_col=self.date_col, values_only=True), start=self.hr + 1):
                self.cached_dates[r] = v
        cached.close()
        self.last = self._last_row()

    def _col(self, name):
        return next((ci for ci, h in self.headers.items() if norm(h) == norm(name)), None)

    def row_day(self, r):
        d = as_date(self.cached_dates.get(r))
        if d is None and self.call_date_col:
            d = as_date(self.ws.cell(r, self.call_date_col).value)
        return d

    def rows_of_day(self, day):
        return [r for r in range(self.hr + 1, self.last + 1) if self.row_day(r) == day]

    def _last_row(self):
        for r in range(self.ws.max_row, self.hr, -1):
            if any(self.ws.cell(r, ci).value not in (None, "") for ci in self.headers):
                return r
        return self.hr

    def has_day(self, day):
        return bool(self.rows_of_day(day))

    def remove_day(self, day):
        """Clear that day's rows so they can be written again (see remove_period)."""
        self.remove_period(day, day)

    def remove_period(self, first_day, last_day, anywhere=False):
        """Clear the rows dated first_day..last_day so they can be written again.
        anywhere=False: only allowed when they are the last block of the sheet, so no other rows
        move. anywhere=True: delete those rows wherever they are (as done by hand in Excel) and
        re-point the drag-down formulas of the rows that moved up."""
        label = str(first_day) if first_day == last_day else f"{first_day} to {last_day}"
        found = [r for r in range(self.hr + 1, self.last + 1)
                 if (d := self.row_day(r)) is not None and first_day <= d <= last_day]
        if not found:
            return 0
        if anywhere and found != list(range(found[0], self.last + 1)):
            return self._delete_rows(found, label)
        first = found[0]
        if found != list(range(first, self.last + 1)):
            raise RunError(f"{label} is already in the master sheet but its rows are not the last rows "
                           f"(rows {found[0]}-{found[-1]} of {self.last}), so they can't be replaced "
                           f"safely. Remove them by hand and re-run.")
        for r in range(first, self.last + 1):
            for ci in self.headers:
                self.ws.cell(r, ci).value = None
        log.info("Cleared %d existing rows for %s (rows %d-%d) to replace them",
                 len(found), label, first, self.last)
        self.table_end = self.last
        self.last = first - 1
        return len(found)

    def _delete_rows(self, rows, label):
        """Delete the given rows (anywhere in the sheet), keeping every other row's values, and
        rewrite the formula cells below so each refers to its own row again."""
        from openpyxl.formula.translate import Translator
        # formula cells per column, by row, before deleting (their text still points at the old row)
        formula_cols = {}
        for ci in self.headers:
            for r in range(self.last, max(self.hr, self.last - 500), -1):
                v = self.ws.cell(r, ci).value
                if isinstance(v, str) and v.startswith("="):
                    formula_cols[ci] = True
                    break
        # delete bottom-up in runs of consecutive rows
        runs, start, prev = [], rows[0], rows[0]
        for r in rows[1:]:
            if r != prev + 1:
                runs.append((start, prev))
                start = r
            prev = r
        runs.append((start, prev))
        old_last = self.last
        for a, b in reversed(runs):
            self.ws.delete_rows(a, b - a + 1)
        self.last = old_last - len(rows)
        # every formula cell that moved: rewrite it for the row it now sits in
        moved_from = rows[0]
        fixed = 0
        for ci in formula_cols:
            for r in range(moved_from, self.last + 1):
                cell = self.ws.cell(r, ci)
                v = cell.value
                if isinstance(v, str) and v.startswith("="):
                    # where this cell was before the delete: r + number of deleted rows above it
                    old_row = r + _deleted_before(rows, r)
                    if old_row != r:
                        cell.value = Translator(v, origin=f"{cell.column_letter}{old_row}").translate_formula(
                            f"{cell.column_letter}{r}")
                        fixed += 1
        # tables / filters that covered the old last row end at the new last row
        for table in self.ws.tables.values():
            m = re.fullmatch(r"([A-Z]+)(\d+):([A-Z]+)(\d+)", table.ref)
            if m and int(m.group(4)) == old_last:
                table.ref = f"{m.group(1)}{m.group(2)}:{m.group(3)}{max(self.last, int(m.group(2)) + 1)}"
                if table.autoFilter is not None:
                    table.autoFilter.ref = table.ref
        log.info("Deleted %d existing rows for %s (in %d block%s, as done by hand); "
                 "re-pointed %d formula cells of the rows that moved up",
                 len(rows), label, len(runs), "" if len(runs) == 1 else "s", fixed)
        return len(rows)

    def append(self, export_header, rows):
        from openpyxl.formula.translate import Translator
        sample_row = self.last if self.last > self.hr else None
        # Formula columns (like the drag-down "Date"): use the nearest formula above the new rows,
        # so one blank or overwritten cell at the bottom doesn't stop the fill-down.
        formula_src = {}
        for ci in self.headers:
            for r in range(self.last, max(self.hr, self.last - 500), -1):
                v = self.ws.cell(r, ci).value
                if isinstance(v, str) and v.startswith("="):
                    formula_src[ci] = self.ws.cell(r, ci)
                    break
        formula_cols = set(formula_src)
        required = self.report.get("FORMULA_COLUMNS")
        for name in [x.strip() for x in required.split(",") if x.strip()]:
            ci = next((c for c, h in self.headers.items() if norm(h) == norm(name)), None)
            if ci is None or ci not in formula_cols:
                raise RunError(f"No formula found in the '{name}' column of the master sheet to drag down. "
                               f"Put the formula back in its last row, then re-run.")
        if formula_cols:
            log.info("Filling down formula columns: %s", [self.headers[ci] for ci in formula_cols])

        data_cols = sorted(ci for ci in self.headers if ci not in formula_cols)
        # Header check before every paste: the new data's headers must be the master's headers,
        # in the same order (formula columns excepted). Any difference stops the run untouched.
        master_h = [str(self.headers[ci]).strip() for ci in data_cols]
        export_h = [str(h or "").strip() for h in export_header]
        differ = [(k, master_h[k] if k < len(master_h) else "(none)",
                   export_h[k] if k < len(export_h) else "(none)")
                  for k in range(max(len(master_h), len(export_h)))
                  if k >= len(master_h) or k >= len(export_h) or norm(master_h[k]) != norm(export_h[k])]
        if differ:
            from openpyxl.utils import get_column_letter
            detail = "; ".join(f"column {get_column_letter(data_cols[k]) if k < len(data_cols) else '?'}: "
                               f"master '{mh}' vs new data '{eh}'" for k, mh, eh in differ[:8])
            raise RunError(f"Header check failed - the new data does not match the master "
                           f"({len(export_h)} columns vs {len(master_h)}; {len(differ)} differ). {detail}. "
                           f"Nothing was added.")
        log.info("Header check passed: all %d columns match the master; pasting", len(master_h))
        mapping = {ci: k for k, ci in enumerate(data_cols)}
        for ci in formula_cols:
            mapping[ci] = None
        start = self.last + 1
        for k, row in enumerate(rows):
            r = start + k
            for ci, e in mapping.items():
                sample = self.ws.cell(sample_row, ci) if sample_row else None
                if ci in formula_cols:
                    # Same as dragging the formula down in Excel: references shift with the row.
                    src = formula_src[ci]
                    value = Translator(src.value, origin=src.coordinate).translate_formula(
                        f"{src.column_letter}{r}")
                else:
                    raw = row[e] if e is not None and e < len(row) else None
                    value = convert_like(raw, sample.value if sample else None)
                cell = self.ws.cell(r, ci, value)
                if sample is not None and sample.has_style:
                    cell._style = copy(sample._style)
        new_last = start + len(rows) - 1

        # Resize an Excel table that ended at the old last row, so it covers exactly the data.
        old_end = getattr(self, "table_end", None) or self.last
        for table in self.ws.tables.values():
            m = re.fullmatch(r"([A-Z]+)(\d+):([A-Z]+)(\d+)", table.ref)
            if m and int(m.group(4)) == old_end:
                table.ref = f"{m.group(1)}{m.group(2)}:{m.group(3)}{new_last}"
                if table.autoFilter is not None:
                    table.autoFilter.ref = table.ref
        filled = sum(1 for ci, e in mapping.items() if e is not None) + len(formula_cols)
        log.info("Appended %d rows to '%s' (rows %d-%d); filled columns: %d of %d",
                 len(rows), self.ws.title, start, new_last, filled, len(self.headers))
        self.last = new_last

    def to_bytes(self):
        out = io.BytesIO()
        self.wb.save(out)
        return out.getvalue()


def _deleted_before(deleted, new_row):
    """How many deleted rows were above the row that now sits at new_row (deleted is sorted)."""
    import bisect
    # find k = number of deleted rows d with d <= new_row + k  (fixed point, k grows monotonically)
    k = 0
    while True:
        k2 = bisect.bisect_right(deleted, new_row + k)
        if k2 == k:
            return k
        k = k2


def update_master(sp, path, day, header, rows, if_present, report=None):
    for attempt in range(1, 6):
        wb_bytes, etag = sp.download(path)
        master = Master(wb_bytes, report)
        if master.has_day(day):
            if if_present == "skip":
                raise AlreadyPresent()
            if if_present == "replace":
                master.remove_day(day)
            else:
                log.warning("%s is already in the master sheet; appending again as asked", day)
        master.append(header, rows)
        try:
            sp.upload(path, master.to_bytes(), if_match=etag)
            log.info("Master workbook saved to SharePoint")
            return
        except UploadConflict:
            log.warning("Master changed while updating (attempt %d); retrying with the latest copy", attempt)
        except FileLocked:
            log.warning("Master is locked, probably open in Excel desktop (attempt %d); waiting 60s", attempt)
            time.sleep(60)
    raise RunError("Could not save the master workbook after 5 attempts (it kept changing or stayed "
                   "locked). Close it in Excel desktop and re-run.")


# ----------------------------------------------------------------------------- main

def run(report, argv=None):
    """Export one day of a Corefactor report, archive it, and append it to its master sheet."""
    ap = argparse.ArgumentParser(description=f"Corefactor {report.title} -> SharePoint master sheet")
    ap.add_argument("--date", help="day to export, YYYY-MM-DD (default: yesterday, IST)")
    ap.add_argument("--if-present", choices=["skip", "replace", "append"], default=report.get("IF_PRESENT"),
                    help="when the day is already in the master: skip it (default), replace its rows "
                         "(only if they are the last rows), or append again")
    ap.add_argument("--download-only", action="store_true", help="only download the export, skip SharePoint")
    ap.add_argument("--wait-minutes", type=int, default=20, help="how long to wait for the export (default 20)")
    args = ap.parse_args(argv)
    setup_logging()

    try:
        day = (datetime.strptime(args.date, "%Y-%m-%d").date() if args.date
               else datetime.now(IST).date() - timedelta(days=1))
        log.info("Corefactor %s for %s", report.title, day)
        out_dir = Path(env("OUTPUT_DIR", "reports"))
        out_dir.mkdir(parents=True, exist_ok=True)

        sp = archive = master_path = None
        if not args.download_only:
            sp = SharePoint.from_env(f"{report.prefix}_SITE_URL", f"{report.prefix}_LIBRARY")
            master_path = report.get("MASTER_PATH", required=True)
            if env("SP_SITE_URL"):
                archive = SharePoint.from_env("SP_SITE_URL", "SP_LIBRARY")

        cf = Corefactor(env("COREFACTOR_BASE_URL", "https://tw1.teleduce.corefactors.in"),
                        env("COREFACTOR_SESSIONID", required=True))
        cf.open_call_logs()
        file_name = f"{report.export}_{day.isoformat()}_auto_{datetime.now(IST):%H%M%S}"
        if report.export == "leadbox":
            cf.request_leadbox_export(day, file_name)
        else:
            cf.request_export(day, file_name)
        zip_bytes = cf.download(cf.wait_for_export(file_name, args.wait_minutes * 60))

        inner_name, raw, header, rows = read_export(zip_bytes)
        header, rows = drop_columns(header, rows, report.get("DROP_COLUMNS"))
        local = out_dir / f"{report.file_prefix}_{day.isoformat()}{Path(inner_name).suffix.lower()}"
        local.write_bytes(raw)
        log.info("Saved %s", local)

        date_key = norm(report.get("FALLBACK_DATE_COLUMN"))
        di = next((j for j, h in enumerate(header) if norm(h) == date_key), None)
        off_day = 0 if di is None else sum(
            1 for r in rows if di < len(r) and (d := parse_dt(r[di])) and d.date() != day)
        if off_day:
            log.warning("%d exported rows are dated outside %s - please check the export", off_day, day)

        if not rows:
            log.warning("The export has no rows for %s; nothing was archived or added", day)
            return 0
        if sp is None:
            return 0

        # The archive copy is saved every day, even when the master already has that day.
        archive_error = None
        folder = report.get("ARCHIVE_FOLDER")
        if archive:
            try:
                archive.ensure_folder(folder)
                archive.upload(f"{folder.strip('/')}/{local.name}", raw)
                log.info("Archived %s in '%s'", local.name, folder)
            except Exception as exc:     # still update the master, but fail the run afterwards
                archive_error = f"Could not save the archive copy in '{folder}': {exc}"
                log.error("%s", archive_error)

        try:
            update_master(sp, master_path, day, header, rows, args.if_present, report)
            log.info("Done: %d rows for %s added to the master sheet", len(rows), day)
        except AlreadyPresent:
            log.info("The master sheet already has %s, so it was left unchanged "
                     "(run with 'replace' to overwrite that day's rows)", day)
        if archive_error:
            raise RunError(archive_error + " The master sheet was updated; the day's file is in this "
                           "run's artifacts, so upload it to the archive folder by hand.")
        return 0

    except RunError as exc:
        log.error("%s", exc)
        return 1


def main():
    return run(CALL_LOGS)


if __name__ == "__main__":
    sys.exit(main())
