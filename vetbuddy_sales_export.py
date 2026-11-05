"""
VetBuddy daily automation (Sanchu Animal Hospital)
=================================================
Every morning (GitHub Actions, 6:47 AM IST):
  1. Log in to VetBuddy and download "Detailed Goods & Services usage by Patients"
     for the month to date (1st -> yesterday; on the 1st: the whole previous month),
     all clinics.
  2. Convert it to .xlsx without the title rows and summary rows.
  3. Upload it to SharePoint:  <library>/<SP_FOLDER>   (e.g. Sales Reports Sanchu/CRM Upload)
  4. Update the master workbook in SharePoint (master_sheet.py):
     replace this month's rows, AX = date, AY = Vet on Wheels unit (vow.py).
  5. Load the same rows into the Supabase database for the Teams bot (vetbuddy_sql.py).
  6. Download Gofrugal pharmacy sales + returns (month to date): .xlsx to SharePoint
     <library>/Gofrugal Upload, and rows into the database with the Vet on Wheels split.
Every night (11:47 PM IST): CRM Upload -> CRM Archive, Gofrugal Upload -> Gofrugal Archive.

Usage:
  python vetbuddy_sales_export.py             morning run
  python vetbuddy_sales_export.py --archive   night run
  python vetbuddy_sales_export.py --backfill  one time: whole master -> Supabase
  python vetbuddy_sales_export.py --backfill-pharmacy   one time: Gofrugal history -> Supabase

Settings come from environment variables (GitHub secrets/variables) or a .env file
next to this script. Exit code 0 = success, 1 = something failed (see the log).
"""

import datetime as dt
import logging
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

BASE = "https://sanchu.thevetbuddy.com"
REPORT_URL = f"{BASE}/sanchu/sales_by_planitem.php"
XLS_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # old-style Excel (.xls)
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


# ---------- settings ----------
def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


load_env(HERE / ".env")
USER = os.environ.get("VETBUDDY_USER", "")
PASSWORD = os.environ.get("VETBUDDY_PASS", "")
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", str(HERE / "reports")))
KEEP_ONLY_LATEST = os.environ.get("KEEP_ONLY_LATEST", "false").lower() == "true"

SP_TENANT_ID = os.environ.get("SP_TENANT_ID", "")
SP_CLIENT_ID = os.environ.get("SP_CLIENT_ID", "")
SP_CLIENT_SECRET = os.environ.get("SP_CLIENT_SECRET", "")
SP_SITE_URL = os.environ.get("SP_SITE_URL", "")              # https://x.sharepoint.com/sites/SalesTeam
SP_LIBRARY = os.environ.get("SP_LIBRARY", "Documents")        # document library
SP_FOLDER = os.environ.get("SP_FOLDER", "VetBuddy Reports")   # daily file goes here
SP_ARCHIVE_FOLDER = os.environ.get("SP_ARCHIVE_FOLDER", "") or f"{SP_FOLDER.strip('/')}/Archive"
SP_GOFRUGAL_FOLDER = os.environ.get("SP_GOFRUGAL_FOLDER", "") or "Gofrugal Upload"     # next to CRM Upload
SP_GOFRUGAL_ARCHIVE_FOLDER = os.environ.get("SP_GOFRUGAL_ARCHIVE_FOLDER", "") or "Gofrugal Archive"
SP_MASTER_PATH = os.environ.get("SP_MASTER_PATH", "")         # e.g. Vetbuddy Master Data 2.xlsx
SP_ENABLED = all([SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE_URL])

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[logging.FileHandler(HERE / "vetbuddy_export.log", encoding="utf-8"),
              logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("vetbuddy")

import gofrugal  # noqa: E402  (after logging is set up)
import master_sheet  # noqa: E402
import vetbuddy_sql  # noqa: E402


# ---------- date range ----------
def mtd_range(today: dt.date) -> tuple[dt.date, dt.date]:
    yesterday = today - dt.timedelta(days=1)
    if today.day == 1:  # no MTD yet -> full previous month
        return yesterday.replace(day=1), yesterday
    return today.replace(day=1), yesterday


# ---------- VetBuddy steps ----------
def is_logged_in(s: requests.Session) -> bool:
    # When logged out, VetBuddy answers report URLs with a login form or a
    # script that redirects to login.php.
    r = s.get(REPORT_URL, params={"txthidedate": "true", "ajaxtab": "true"}, timeout=120)
    t = r.text
    return "login.php" not in t and 'name="passwd"' not in t and len(t) > 500


def login(s: requests.Session) -> None:
    creds = {"userid": USER, "passwd": PASSWORD, "login": "login"}

    # 1) The report section's own login page
    s.get(f"{BASE}/sanchu/login.php", params={"redirectto": "sales_by_planitem.php"}, timeout=60)
    r1 = s.post(f"{BASE}/sanchu/login.php",
                data={**creds, "redirectto": "sales_by_planitem.php"}, timeout=120)
    if is_logged_in(s):
        log.info("Logged in as %s", USER)
        return

    # 2) Fallback: the main login page (it posts as multipart/form-data)
    s.get(f"{BASE}/vet_index.html", timeout=60)
    s.get(f"{BASE}/vet_inc_session.html",
          params={"calledfromlogin": "true", "viewport": "1280|800"}, timeout=60)
    r2 = s.post(f"{BASE}/comm_whiteboard.html",
                files={k: (None, v) for k, v in creds.items()}, timeout=120)
    if is_logged_in(s):
        log.info("Logged in as %s (main login page)", USER)
        return

    # Save what VetBuddy answered, to help diagnose (password is not in it)
    (HERE / "login_debug.html").write_text(
        "<!-- sanchu/login.php -->\n" + r1.text[:20000]
        + "\n<!-- comm_whiteboard.html -->\n" + r2.text[:20000],
        encoding="utf-8", errors="replace")
    raise RuntimeError("Login failed - check VETBUDDY_USER / VETBUDDY_PASS in .env "
                       "(VetBuddy's reply saved to login_debug.html)")


def wait_until_free(s: requests.Session, tries: int = 20) -> None:
    for _ in range(tries):
        r = s.get(f"{BASE}/sanchu/statcheck.php",
                  params={"filename": "sales_by_planitem.php", "_": int(time.time() * 1000)},
                  timeout=60)
        if "busy" not in r.text.lower():
            return
        log.info("VetBuddy says the report is busy, waiting 30s...")
        time.sleep(30)
    raise RuntimeError("Report generator stayed busy for too long")


def generate_xls(s: requests.Session, d_from: dt.date, d_to: dt.date) -> bytes:
    form = {
        "calledforbiller": "", "txthidedate": "true",
        "datefrom": d_from.strftime("%m/%d/%Y"), "dateTo": d_to.strftime("%m/%d/%Y"),
        "selclinic": "All",
        "txtstockitem": "", "selstockid": "", "hidcheckforcheckbox": "",
        "selprovider": "", "selsalestype": "",
        "txtclient": "", "hidclient": "",
        "txtclient_hiddefaultvalue": "", "txtclient_hidnextcontrol": "",
        "chkgoods": "chkgoods", "chkservice": "service",
        "lstscheduledrug": "", "chkcomment": "All",
        "cmdxls": "Extract XLS Report",
    }
    wait_until_free(s)
    log.info("Requesting report %s -> %s (all clinics)...", d_from, d_to)
    r = s.post(REPORT_URL, data=form, timeout=900)  # big months can take minutes
    m = re.search(r'href="(doc/[^"]+\.xls)"', r.text, re.I)
    if not m:
        raise RuntimeError("Report page did not return an XLS link (session expired or layout changed)")
    f = s.get(f"{BASE}/sanchu/{m.group(1)}", timeout=600)
    f.raise_for_status()
    if not f.content.startswith(XLS_MAGIC):
        raise RuntimeError("Downloaded file is not an Excel file")
    return f.content


# ---------- .xls -> .xlsx ----------
def xls_to_xlsx(xls_bytes: bytes, dest: Path) -> list:
    """Convert VetBuddy's old-style .xls to .xlsx, keeping values, dates,
    number formats, bold text, merged cells and column widths.
    Returns the rows written (header first) as Python values."""
    rows_out: list = []
    import xlrd
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    src = xlrd.open_workbook(file_contents=xls_bytes, formatting_info=True)
    wb = Workbook()
    wb.remove(wb.active)
    bold = Font(bold=True)

    for sh in src.sheets():
        ws = wb.create_sheet(sh.name[:31])
        first, last = data_rows(sh)
        log.info("Keeping rows %d-%d of %d (removed %d title rows at top, %d summary rows at bottom)",
                 first + 1, last + 1, sh.nrows, first, sh.nrows - 1 - last)
        for r in range(first, last + 1):
            row_vals = [None] * sh.ncols
            if not rows_out or sh is src.sheet_by_index(0):
                rows_out.append(row_vals)
            for c in range(sh.ncols):
                cell = sh.cell(r, c)
                if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                    continue
                value = cell.value
                fmt = None
                if cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        value = xlrd.xldate.xldate_as_datetime(value, src.datemode)
                        fmt = "dd-mm-yyyy hh:mm" if value.hour or value.minute else "dd-mm-yyyy"
                    except Exception:  # noqa: BLE001  (odd date -> keep the number)
                        pass
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    value = bool(value)
                elif cell.ctype == xlrd.XL_CELL_ERROR:
                    value = xlrd.error_text_from_code.get(value, "#ERR")
                elif cell.ctype == xlrd.XL_CELL_NUMBER:
                    if value == int(value) and abs(value) < 1e15:
                        value = int(value)  # 374940.0 -> 374940, phone numbers stay whole
                    xf = src.xf_list[cell.xf_index]
                    nf = src.format_map.get(xf.format_key)
                    if nf and nf.format_str and nf.format_str != "General":
                        fmt = nf.format_str
                row_vals[c] = value
                out = ws.cell(row=r - first + 1, column=c + 1, value=value)
                if fmt:
                    out.number_format = fmt
                xf = src.xf_list[cell.xf_index]
                if src.font_list[xf.font_index].bold:
                    out.font = bold

        # keep only merges that sit fully inside the kept rows
        for rlo, rhi, clo, chi in sh.merged_cells:
            if rlo >= first and rhi - 1 <= last:
                ws.merge_cells(start_row=rlo - first + 1, start_column=clo + 1,
                               end_row=rhi - first, end_column=chi)
        for c, info in sh.colinfo_map.items():
            if c < sh.ncols and info.width:
                ws.column_dimensions[get_column_letter(c + 1)].width = min(info.width / 256, 60)
        ws.freeze_panes = "A2"  # header row stays visible when scrolling

    wb.save(dest)
    return rows_out


def data_rows(sh) -> tuple[int, int]:
    """Return (header_row, last_data_row) as 0-based indexes.
    Header = the row starting with 'Sr No.' (normally row 5).
    Last data row = last row after it whose first cell is a serial number,
    i.e. everything below (Total, blank rows, tax summary) is dropped."""
    first = next((r for r in range(min(sh.nrows, 30))
                  if str(sh.cell_value(r, 0)).strip().lower().startswith("sr no")), None)
    if first is None:
        log.warning("'Sr No.' header not found - falling back to removing first 4 / last 11 rows")
        return 4, max(4, sh.nrows - 12)
    last = first
    for r in range(first + 1, sh.nrows):
        if sh.cell_type(r, 0) == 2:  # number in column A = a data line
            last = r
        else:
            break
    return first, last


# ---------- SharePoint (Microsoft Graph, app-only) ----------
GRAPH = "https://graph.microsoft.com/v1.0"
CHUNK = 320 * 1024 * 16  # 5 MiB, must be a multiple of 320 KiB


def graph_token() -> str:
    r = requests.post(
        f"https://login.microsoftonline.com/{SP_TENANT_ID}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": SP_CLIENT_ID,
              "client_secret": SP_CLIENT_SECRET,
              "scope": "https://graph.microsoft.com/.default"},
        timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f"Microsoft sign-in failed: {r.text[:300]}")
    token = r.json()["access_token"]
    try:  # show which app permissions the token carries (no secrets in this)
        import base64
        import json as _json
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        roles = _json.loads(base64.urlsafe_b64decode(payload)).get("roles", [])
        log.info("Microsoft app permissions in token: %s", roles or "NONE")
        if not roles:
            log.warning("The app has NO application permissions. In Azure > App registrations > "
                        "API permissions: add Microsoft Graph > Application > Sites.ReadWrite.All "
                        "and click 'Grant admin consent'.")
    except Exception:  # noqa: BLE001
        pass
    return token


def _check(r: requests.Response, what: str) -> None:
    if r.status_code >= 400:
        raise RuntimeError(f"{what} failed ({r.status_code}): {r.text[:400]}")


def sp_drive(h: dict) -> dict:
    """Find the SharePoint document library (drive) from SP_SITE_URL + SP_LIBRARY."""
    # site from its URL, e.g. https://contoso.sharepoint.com/sites/Finance
    u = urlparse(SP_SITE_URL.rstrip("/"))
    r = requests.get(f"{GRAPH}/sites/{u.netloc}:{u.path or '/'}", headers=h, timeout=60)
    _check(r, f"Opening SharePoint site {SP_SITE_URL}")
    site_id = r.json()["id"]

    # document library (default "Documents" = "Shared Documents")
    r = requests.get(f"{GRAPH}/sites/{site_id}/drives", headers=h, timeout=60)
    _check(r, "Listing document libraries")
    drives = r.json()["value"]
    want = SP_LIBRARY.strip().strip("/").lower()

    def names(d: dict) -> set:
        # display name, plus the name in its web address (…/sites/X/<url-name>)
        url_name = unquote(d.get("webUrl", "").rstrip("/").rsplit("/", 1)[-1])
        return {d.get("name", "").lower(), url_name.lower()}

    drive = next((d for d in drives if want in names(d)), None)
    if drive is None:
        raise RuntimeError(f"Library '{SP_LIBRARY}' not found. Available: "
                           + ", ".join(d["name"] for d in drives))
    return drive


def sp_ensure_folder(h: dict, drive_id: str, folder_path: str) -> str:
    """Return the item id of folder_path in the library, creating it (and parents) if missing."""
    parent_id = None
    walked = []
    for part in [p for p in folder_path.strip("/").split("/") if p]:
        walked.append(part)
        r = requests.get(f"{GRAPH}/drives/{drive_id}/root:/{quote('/'.join(walked))}",
                         headers=h, timeout=60)
        if r.status_code == 404:
            parent = f"items/{parent_id}" if parent_id else "root"
            r = requests.post(f"{GRAPH}/drives/{drive_id}/{parent}/children", headers=h, timeout=60,
                              json={"name": part, "folder": {},
                                    "@microsoft.graph.conflictBehavior": "fail"})
            _check(r, f"Creating folder '{'/'.join(walked)}'")
            log.info("Created SharePoint folder %s", "/".join(walked))
        else:
            _check(r, f"Opening folder '{'/'.join(walked)}'")
        parent_id = r.json()["id"]
    if parent_id is None:
        r = requests.get(f"{GRAPH}/drives/{drive_id}/root", headers=h, timeout=60)
        _check(r, "Opening library root")
        parent_id = r.json()["id"]
    return parent_id


def sharepoint_archive() -> int:
    """End of day: move the day's files to their archive folders:
    VetBuddy  SP_FOLDER          -> SP_ARCHIVE_FOLDER
    Gofrugal  SP_GOFRUGAL_FOLDER -> SP_GOFRUGAL_ARCHIVE_FOLDER"""
    h = {"Authorization": f"Bearer {graph_token()}"}
    drive = sp_drive(h)
    total = 0
    for src, dst, prefix in ((SP_FOLDER, SP_ARCHIVE_FOLDER, "VetBuddy_GoodsServices_MTD_"),
                             (SP_GOFRUGAL_FOLDER, SP_GOFRUGAL_ARCHIVE_FOLDER, "Gofrugal_Pharmacy_MTD_")):
        src = src.strip("/")
        src_path = f"root:/{quote(src)}:" if src else "root"
        r = requests.get(f"{GRAPH}/drives/{drive['id']}/{src_path}/children",
                         params={"$top": "999"}, headers=h, timeout=60)
        if r.status_code == 404:
            log.info("Folder '%s' does not exist yet - nothing to archive", src)
            continue
        _check(r, f"Listing folder '{src}'")
        files = [i for i in r.json().get("value", []) if "file" in i and i["name"].startswith(prefix)]
        if not files:
            log.info("Nothing to archive in '%s'", src)
            continue
        dest_id = sp_ensure_folder(h, drive["id"], dst)
        for f in files:
            r = requests.patch(f"{GRAPH}/drives/{drive['id']}/items/{f['id']}",
                               params={"@microsoft.graph.conflictBehavior": "replace"},
                               headers=h, timeout=60,
                               json={"parentReference": {"id": dest_id}, "name": f["name"]})
            _check(r, f"Moving {f['name']}")
            log.info("Moved %s -> %s/", f["name"], dst)
            total += 1
    log.info("Archived %d file(s)", total)
    return 0


def sp_put_file(h: dict, drive_id: str, local: Path, item_path: str, if_match: str = "") -> dict:
    """Upload a local file to <library>/<item_path> (replacing it), in chunks.
    With if_match (an eTag), the upload is refused if someone changed the file meanwhile."""
    hh = dict(h)
    if if_match:
        hh["If-Match"] = if_match
    r = requests.post(
        f"{GRAPH}/drives/{drive_id}/root:/{quote(item_path)}:/createUploadSession",
        headers=hh, json={"item": {"@microsoft.graph.conflictBehavior": "replace"}}, timeout=60)
    _check(r, f"Starting upload of {item_path}")
    upload_url = r.json()["uploadUrl"]  # pre-authorised: no token header on chunks

    total = local.stat().st_size
    try:
        with open(local, "rb") as f:
            start = 0
            while start < total:
                part = f.read(CHUNK)
                end = start + len(part) - 1
                r = requests.put(upload_url, data=part, timeout=300, headers={
                    "Content-Length": str(len(part)),
                    "Content-Range": f"bytes {start}-{end}/{total}"})
                if r.status_code not in (200, 201, 202):
                    raise RuntimeError(f"Upload chunk failed ({r.status_code}): {r.text[:300]}")
                start = end + 1
    except Exception:
        # cancel the unfinished upload, otherwise SharePoint blocks the next try
        # with "A file with the same name is currently being uploaded"
        try:
            requests.delete(upload_url, timeout=60)
        except Exception:  # noqa: BLE001
            pass
        raise
    return r.json()


def sharepoint_upload(path: Path, folder: str = "") -> None:
    folder = (folder or SP_FOLDER).strip("/")
    h = {"Authorization": f"Bearer {graph_token()}"}
    drive = sp_drive(h)
    sp_ensure_folder(h, drive["id"], folder)          # created on first use
    res = sp_put_file(h, drive["id"], path, f"{folder}/{path.name}" if folder else path.name)
    log.info("Uploaded to SharePoint: %s/%s %s", folder, path.name, res.get("webUrl", ""))


def sp_download_master(h: dict, drive: dict, dest: Path) -> dict:
    """Download the master workbook to `dest`; returns its SharePoint item (with eTag)."""
    path = SP_MASTER_PATH.strip("/")
    r = requests.get(f"{GRAPH}/drives/{drive['id']}/root:/{quote(path)}", headers=h, timeout=60)
    _check(r, f"Finding master file '{path}'")
    item = r.json()
    dest.parent.mkdir(parents=True, exist_ok=True)
    log.info("Downloading master '%s' (%.0f MB)...", path, item.get("size", 0) / 1e6)
    with requests.get(f"{GRAPH}/drives/{drive['id']}/items/{item['id']}/content",
                      headers=h, stream=True, timeout=600) as resp:
        _check(resp, "Downloading master")
        with open(dest, "wb") as f:
            for b in resp.iter_content(1 << 20):
                f.write(b)
    return item


def sharepoint_update_master(rows: list, month: tuple) -> None:
    """Download the master, replace `month` rows with `rows`, set AX/AY, upload it back."""
    h = {"Authorization": f"Bearer {graph_token()}"}
    drive = sp_drive(h)
    work = OUTPUT_DIR / "_master_work"
    src, dst = work / "master_in.xlsx", work / "master_out.xlsx"
    item = sp_download_master(h, drive, src)
    stats = master_sheet.update_master_file(src, dst, rows, month)
    log.info("Master: removed %d rows of %02d/%d, removed %d empty rows, added %d rows "
             "(now %d rows incl. header); VOW: %d invoices / %d lines flagged in column AY",
             stats["removed"], month[1], month[0], stats["empty_rows_dropped"], stats["added"],
             stats["last_row"], stats["vow_invoices"], stats["vow_lines"])
    path = SP_MASTER_PATH.strip("/")
    try:
        sp_put_file(h, drive["id"], dst, path, if_match=item.get("eTag", ""))
    except RuntimeError as e:
        if "412" in str(e):
            raise RuntimeError("Master was changed by someone during the update - will retry") from e
        if "423" in str(e) or "resourceLocked" in str(e) or "nameAlreadyExists" in str(e):
            raise RuntimeError("Master is open/locked by someone (desktop Excel or Excel for the web) "
                               "- will retry in 5 minutes") from e
        raise
    log.info("Master updated in SharePoint: %s", path)
    for p in (src, dst):
        p.unlink(missing_ok=True)


# ---------- runs ----------
def retry(what: str, fn, attempts: int, wait: int, stop_if: str = "NOT changed") -> bool:
    for attempt in range(1, attempts + 1):
        try:
            fn()
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("%s attempt %d/%d failed: %s", what, attempt, attempts, e)
            if stop_if in str(e) or "Login failed" in str(e) or attempt == attempts:
                return False
            time.sleep(wait)
    return False


def main() -> int:
    if not USER or not PASSWORD:
        log.error("VETBUDDY_USER / VETBUDDY_PASS missing")
        return 1
    today = dt.datetime.now(IST).date()
    d_from, d_to = mtd_range(today)
    month = (d_from.year, d_from.month)

    # 1-2. VetBuddy -> trimmed .xlsx
    result = {}

    def export():
        with requests.Session() as s:
            s.headers["User-Agent"] = "Mozilla/5.0 (VetBuddy MTD export)"
            login(s)
            data = generate_xls(s, d_from, d_to)
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        if KEEP_ONLY_LATEST:
            for old in OUTPUT_DIR.glob("VetBuddy_GoodsServices_MTD_*.xls*"):
                old.unlink()
        out = OUTPUT_DIR / f"VetBuddy_GoodsServices_MTD_{d_from}_to_{d_to}.xlsx"
        tmp = out.with_name(out.name + ".part")
        rows = xls_to_xlsx(data, tmp)
        tmp.replace(out)
        log.info("Saved %s (%.1f MB, %d data rows)", out, out.stat().st_size / 1e6, len(rows) - 1)
        result.update(out=out, rows=rows)

    if not retry("Export", export, 3, 60):
        log.error("Export FAILED for %s -> %s", d_from, d_to)
        return 1
    out, rows = result["out"], result["rows"]
    if len(rows) < 2:
        log.error("Report has no data rows - nothing uploaded")
        return 1
    status = 0

    # 3. daily file -> SharePoint
    if not SP_ENABLED:
        log.warning("SharePoint settings missing - file kept locally only")
    elif not retry("SharePoint upload", lambda: sharepoint_upload(out), 3, 30):
        log.error("SharePoint upload FAILED")
        status = 1

    # 4. master workbook (the file can't be replaced while someone has it open: ~30 min of retries)
    if SP_ENABLED and SP_MASTER_PATH:
        if not retry("Master update", lambda: sharepoint_update_master(rows, month), 7, 300):
            log.error("Master update FAILED - the daily file is still in %s", SP_FOLDER)
            status = 1
    elif SP_ENABLED:
        log.warning("Master NOT updated: SP_MASTER_PATH is not set")

    # 5. Supabase database for the Teams bot
    if vetbuddy_sql.ENABLED:
        if not retry("Database load", lambda: vetbuddy_sql.replace_month(rows, month, d_from, d_to), 3, 60):
            log.error("Database load FAILED (yesterday's data is still in the database)")
            status = 1
    else:
        log.info("Database step skipped (SUPABASE_DB_URL not set)")

    # 6. Gofrugal pharmacy: .xlsx -> SharePoint "Gofrugal Upload", rows -> database
    if gofrugal.ENABLED:
        gf = {}

        def gf_download():
            gf["recs"], gf["sales"], gf["returns"] = gofrugal.download_all(d_from, d_to)

        if not retry("Gofrugal download", gf_download, 3, 60):
            log.error("Gofrugal download FAILED")
            return 1
        if SP_ENABLED:
            gpath = OUTPUT_DIR / f"Gofrugal_Pharmacy_MTD_{d_from}_to_{d_to}.xlsx"
            gofrugal.to_xlsx(gf["sales"], gf["returns"], gpath, f"{d_from} to {d_to}")
            log.info("Saved %s (%d sales lines, %d return lines)", gpath.name,
                     len(gf["sales"]), len(gf["returns"]))
            if not retry("Gofrugal upload", lambda: sharepoint_upload(gpath, SP_GOFRUGAL_FOLDER), 3, 30):
                log.error("Gofrugal file upload to SharePoint FAILED")
                status = 1
        if vetbuddy_sql.ENABLED:
            if not retry("Pharmacy load", lambda: vetbuddy_sql.replace_pharmacy(gf["recs"], d_from, d_to), 3, 60):
                log.error("Pharmacy load FAILED (yesterday's pharmacy data is still in the database)")
                status = 1
    else:
        log.info("Gofrugal step skipped (GOFRUGAL_USER / GOFRUGAL_PASS not set)")
    return status


def pharmacy_load(d_from: dt.date, d_to: dt.date, session=None) -> None:
    recs = gofrugal.download(d_from, d_to, session)
    vetbuddy_sql.replace_pharmacy(recs, d_from, d_to)


def backfill_pharmacy_main() -> int:
    """One time: load Gofrugal pharmacy history, month by month, from the first month in
    the database (or PHARMACY_FROM=YYYY-MM-DD) up to yesterday."""
    if not (gofrugal.ENABLED and vetbuddy_sql.ENABLED):
        log.error("Pharmacy backfill needs GOFRUGAL_USER / GOFRUGAL_PASS and SUPABASE_DB_URL")
        return 1
    start = os.environ.get("PHARMACY_FROM", "")
    if start:
        first = dt.date.fromisoformat(start)
    else:
        with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT min(sale_date) FROM vetbuddy.sales")
            first = cur.fetchone()[0] or dt.date.today().replace(day=1)
    end = dt.datetime.now(IST).date() - dt.timedelta(days=1)
    gs = gofrugal.Session()
    gs.login()
    m = first.replace(day=1)
    status = 0
    while m <= end:
        nxt = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        a, b = max(m, first), min(nxt - dt.timedelta(days=1), end)
        if not retry(f"Pharmacy {a:%b %Y}", lambda: pharmacy_load(a, b, gs), 3, 60):
            status = 1
        m = nxt
    return status


def archive_main() -> int:
    if not SP_ENABLED:
        log.error("SharePoint settings missing - cannot archive")
        return 1
    ok = retry("Archive", sharepoint_archive, 3, 30)
    if not ok:
        log.error("Archive FAILED")
    return 0 if ok else 1


def backfill_main() -> int:
    """One time: load the whole master workbook from SharePoint into Supabase."""
    if not (SP_ENABLED and SP_MASTER_PATH and vetbuddy_sql.ENABLED):
        log.error("Backfill needs the SharePoint settings, SP_MASTER_PATH and SUPABASE_DB_URL")
        return 1
    h = {"Authorization": f"Bearer {graph_token()}"}
    local = OUTPUT_DIR / "_master_work" / "master_backfill.xlsx"
    sp_download_master(h, sp_drive(h), local)
    vetbuddy_sql.backfill_from_master(local)
    local.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    if "--archive" in sys.argv:
        sys.exit(archive_main())
    if "--backfill-pharmacy" in sys.argv:
        sys.exit(backfill_pharmacy_main())
    sys.exit(backfill_main() if "--backfill" in sys.argv else main())
