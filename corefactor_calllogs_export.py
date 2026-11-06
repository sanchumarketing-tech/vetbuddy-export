#!/usr/bin/env python3
"""
Corefactor (Teleduce) daily call-log export -> SharePoint master sheet.

What it does
  1. Uses a saved Corefactor browser session to request a Call Logs export for one day
     (yesterday in IST by default). This is the same request the "Export" button sends.
  2. Waits for the file to appear in Export History, downloads the zip and unzips it.
  3. Keeps a copy in OUTPUT_DIR (and, optionally, in a SharePoint folder).
  4. Appends the rows to the master workbook on SharePoint, matching columns by header
     name. Each new row copies the formatting and value types of the last existing row, and
     any formula column (like the drag-down "Date" column) is filled down from the row above.
     If that date is already in the master sheet, the run is skipped (use --force to append anyway).

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
  SP_SITE_URL              e.g. https://contoso.sharepoint.com/sites/Operations, or a personal
                           OneDrive such as https://contoso-my.sharepoint.com/personal/user_contoso_com
  SP_LIBRARY               document library name (default "Documents")
  SP_CALLLOG_MASTER_PATH   master workbook path inside the library, e.g. "Reports/Call Logs Master.xlsx"
  SP_CALLLOG_SHEET         worksheet to append to (default: the first sheet)
  SP_CALLLOG_HEADER_ROW    row that holds the column headers (default 1)
  SP_CALLLOG_DATE_COLUMN   header of the call date column, used to skip duplicates (default "Call Date")
  SP_CALLLOG_FOLDER        optional library folder to keep each day's raw export file
  SP_CALLLOG_FORMULA_COLUMNS  formula columns that must be dragged down (default "Date");
                           the run stops rather than add rows without them

Usage
  python corefactor_calllogs_export.py                       # yesterday (IST)
  python corefactor_calllogs_export.py --date 2026-11-05     # a specific day
  python corefactor_calllogs_export.py --date 2026-11-05 --force
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
from html import unescape
from pathlib import Path
from urllib.parse import quote, urlparse

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

    def wait_for_export(self, file_name, timeout_s, poll_s=20):
        deadline = time.time() + timeout_s
        while True:
            resp = self.s.get(self.base + "/export-history/?switch_exp=legacy", timeout=90)
            self._check(resp)
            for row in re.split(r"<tr[\s>]", resp.text, flags=re.I)[1:]:
                if file_name in unescape(row):
                    m = re.search(r"href=[\"'](/export-data/[0-9a-fA-F-]{36}/)[\"']", row)
                    if m:
                        log.info("Export is ready in Export History")
                        return self.base + m.group(1)
            if time.time() > deadline:
                save_debug(resp.text)
                raise RunError(f"The export '{file_name}' did not appear in Export History "
                               f"within {timeout_s // 60} minutes.")
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
        drive = next((d for d in drives if d["name"].lower() in wanted), None)
        if not drive:
            # A personal OneDrive (…-my.sharepoint.com/personal/…) has one main drive whose name
            # varies ("OneDrive", "Documents"); use the site's default drive.
            drive = self._get(f"{GRAPH}/sites/{site['id']}/drive").json()
            log.info("Using the site's default drive '%s'", drive.get("name"))
        self.drive = drive["id"]

    @classmethod
    def from_env(cls):
        return cls(env("SP_TENANT_ID", required=True), env("SP_CLIENT_ID", required=True),
                   env("SP_CLIENT_SECRET", required=True), env("SP_SITE_URL", required=True),
                   env("SP_LIBRARY", "Documents"))

    def _get(self, url, **kw):
        resp = requests.get(url, headers=self.h, timeout=120, **kw)
        if resp.status_code >= 400:
            raise RunError(f"SharePoint request failed ({resp.status_code}): {url}\n{resp.text[:300]}")
        return resp

    def _item(self, path):
        return f"{GRAPH}/drives/{self.drive}/root:/{quote(path.strip('/'), safe='/')}"

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
    def __init__(self, wb_bytes):
        from openpyxl import load_workbook
        self.wb = load_workbook(io.BytesIO(wb_bytes))
        sheet = env("SP_CALLLOG_SHEET")
        if sheet and sheet not in self.wb.sheetnames:
            raise RunError(f"Sheet '{sheet}' not found in the master. Sheets: {self.wb.sheetnames}")
        self.ws = self.wb[sheet] if sheet else self.wb.worksheets[0]
        self.hr = int(env("SP_CALLLOG_HEADER_ROW", "1"))
        self.headers = {ci: c.value for ci, c in enumerate(self.ws[self.hr], start=1)
                        if c.value not in (None, "")}
        if not self.headers:
            raise RunError(f"Row {self.hr} of sheet '{self.ws.title}' has no headers.")
        date_key = norm(env("SP_CALLLOG_DATE_COLUMN", "Call Date"))
        self.date_col = next((ci for ci, h in self.headers.items() if norm(h) == date_key), None)
        self.last = self._last_row()

    def _last_row(self):
        for r in range(self.ws.max_row, self.hr, -1):
            if any(self.ws.cell(r, ci).value not in (None, "") for ci in self.headers):
                return r
        return self.hr

    def has_day(self, day):
        if not self.date_col:
            log.warning("No date column found in the master, so duplicates can't be checked")
            return False
        return any((d := parse_dt(self.ws.cell(r, self.date_col).value)) and d.date() == day
                   for r in range(self.hr + 1, self.last + 1))

    def append(self, export_header, rows):
        from openpyxl.formula.translate import Translator
        index = {norm(h): i for i, h in enumerate(export_header) if h}
        mapping = {ci: index.get(norm(h)) for ci, h in self.headers.items()}
        matched = [self.headers[ci] for ci, e in mapping.items() if e is not None]
        if not matched:
            raise RunError(f"None of the master's headers match the export. Master: "
                           f"{list(self.headers.values())}; export: {export_header}")

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
        required = env("SP_CALLLOG_FORMULA_COLUMNS", "Date")
        for name in [x.strip() for x in required.split(",") if x.strip()]:
            ci = next((c for c, h in self.headers.items() if norm(h) == norm(name)), None)
            if ci is None or ci not in formula_cols:
                raise RunError(f"No formula found in the '{name}' column of the master sheet to drag down. "
                               f"Put the formula back in its last row, then re-run.")
        if formula_cols:
            log.info("Filling down formula columns: %s", [self.headers[ci] for ci in formula_cols])
        missing = [self.headers[ci] for ci, e in mapping.items() if e is None and ci not in formula_cols]
        extra = [h for h in export_header if h and norm(h) not in {norm(x) for x in self.headers.values()}]
        if missing:
            log.warning("Master columns not in the export (left blank): %s", missing)
        if extra:
            log.info("Export columns not in the master (ignored): %s", extra)
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

        # Grow an Excel table that ended at the old last row, so it includes the new rows.
        for table in self.ws.tables.values():
            m = re.fullmatch(r"([A-Z]+)(\d+):([A-Z]+)(\d+)", table.ref)
            if m and int(m.group(4)) == self.last:
                table.ref = f"{m.group(1)}{m.group(2)}:{m.group(3)}{new_last}"
                if table.autoFilter is not None:
                    table.autoFilter.ref = table.ref
        log.info("Appended %d rows to '%s' (rows %d-%d); matched columns: %d of %d",
                 len(rows), self.ws.title, start, new_last, len(matched), len(self.headers))
        self.last = new_last

    def to_bytes(self):
        out = io.BytesIO()
        self.wb.save(out)
        return out.getvalue()


def update_master(sp, path, day, header, rows, force):
    for attempt in range(1, 6):
        wb_bytes, etag = sp.download(path)
        master = Master(wb_bytes)
        if master.has_day(day) and not force:
            raise AlreadyPresent()
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

def main():
    ap = argparse.ArgumentParser(description="Corefactor call logs -> SharePoint master sheet")
    ap.add_argument("--date", help="day to export, YYYY-MM-DD (default: yesterday, IST)")
    ap.add_argument("--force", action="store_true", help="append even if the day is already in the master")
    ap.add_argument("--download-only", action="store_true", help="only download the export, skip SharePoint")
    ap.add_argument("--wait-minutes", type=int, default=20, help="how long to wait for the export (default 20)")
    args = ap.parse_args()
    setup_logging()

    try:
        day = (datetime.strptime(args.date, "%Y-%m-%d").date() if args.date
               else datetime.now(IST).date() - timedelta(days=1))
        log.info("Corefactor call logs for %s", day)
        out_dir = Path(env("OUTPUT_DIR", "reports"))
        out_dir.mkdir(parents=True, exist_ok=True)

        sp = master_path = None
        if not args.download_only:
            sp = SharePoint.from_env()
            master_path = env("SP_CALLLOG_MASTER_PATH", required=True)
            if not args.force and Master(sp.download(master_path)[0]).has_day(day):
                raise AlreadyPresent()

        cf = Corefactor(env("COREFACTOR_BASE_URL", "https://tw1.teleduce.corefactors.in"),
                        env("COREFACTOR_SESSIONID", required=True))
        cf.open_call_logs()
        file_name = f"calllogs_{day.isoformat()}_auto_{datetime.now(IST):%H%M%S}"
        cf.request_export(day, file_name)
        zip_bytes = cf.download(cf.wait_for_export(file_name, args.wait_minutes * 60))

        inner_name, raw, header, rows = read_export(zip_bytes)
        local = out_dir / f"Corefactor_CallLogs_{day.isoformat()}{Path(inner_name).suffix.lower()}"
        local.write_bytes(raw)
        log.info("Saved %s", local)

        date_key = norm(env("SP_CALLLOG_DATE_COLUMN", "Call Date"))
        di = next((j for j, h in enumerate(header) if norm(h) == date_key), None)
        off_day = 0 if di is None else sum(
            1 for r in rows if di < len(r) and (d := parse_dt(r[di])) and d.date() != day)
        if off_day:
            log.warning("%d exported rows are dated outside %s - please check the export", off_day, day)

        if not rows:
            log.warning("The export has no calls for %s; the master sheet was not changed", day)
            return 0
        if sp is None:
            return 0

        folder = env("SP_CALLLOG_FOLDER")
        if folder:
            try:
                sp.upload(f"{folder.strip('/')}/{local.name}", raw)
                log.info("Copied %s to SharePoint folder '%s'", local.name, folder)
            except Exception as exc:     # a backup copy failing should not stop the master update
                log.warning("Could not copy the raw file to '%s': %s", folder, exc)

        update_master(sp, master_path, day, header, rows, args.force)
        log.info("Done: %d calls for %s added to the master sheet", len(rows), day)
        return 0

    except AlreadyPresent:
        log.info("The master sheet already has calls for that date; nothing to do (use --force to add anyway)")
        return 0
    except RunError as exc:
        log.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
