"""
VetBuddy daily MTD export
Report : Detailed Goods & Services usage by Patients
Range  : 1st of current month -> yesterday (on the 1st: the whole previous month)
Clinics: All
Output : VetBuddy_GoodsServices_MTD_<from>_to_<to>.xlsx in OUTPUT_DIR (converted from VetBuddy's .xls)

Settings come from a .env file next to this script (see .env.example).
Exit code 0 = success, 1 = failure (details in vetbuddy_export.log).
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

# SharePoint upload (optional – runs only when all four SP_ values are set)
SP_TENANT_ID = os.environ.get("SP_TENANT_ID", "")
SP_CLIENT_ID = os.environ.get("SP_CLIENT_ID", "")
SP_CLIENT_SECRET = os.environ.get("SP_CLIENT_SECRET", "")
SP_SITE_URL = os.environ.get("SP_SITE_URL", "")           # https://contoso.sharepoint.com/sites/Finance
SP_LIBRARY = os.environ.get("SP_LIBRARY", "Documents")     # document library name
SP_FOLDER = os.environ.get("SP_FOLDER", "VetBuddy Reports")  # folder inside the library
SP_ARCHIVE_FOLDER = os.environ.get("SP_ARCHIVE_FOLDER", "") or f"{SP_FOLDER.strip('/')}/Archive"
SP_ENABLED = all([SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE_URL])

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[
        logging.FileHandler(HERE / "vetbuddy_export.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("vetbuddy")


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
def xls_to_xlsx(xls_bytes: bytes, dest: Path) -> None:
    """Convert VetBuddy's old-style .xls to .xlsx, keeping values, dates,
    number formats, bold text, merged cells and column widths."""
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
    """End of day: move VetBuddy report files from SP_FOLDER to SP_ARCHIVE_FOLDER."""
    h = {"Authorization": f"Bearer {graph_token()}"}
    drive = sp_drive(h)
    src = SP_FOLDER.strip("/")
    src_path = f"root:/{quote(src)}:" if src else "root"
    r = requests.get(f"{GRAPH}/drives/{drive['id']}/{src_path}/children",
                     params={"$top": "999"}, headers=h, timeout=60)
    if r.status_code == 404:
        log.info("Folder '%s' does not exist yet - nothing to archive", src)
        return 0
    _check(r, f"Listing folder '{src}'")
    files = [i for i in r.json().get("value", [])
             if "file" in i and i["name"].startswith("VetBuddy_GoodsServices_MTD_")]
    if not files:
        log.info("Nothing to archive in '%s'", src)
        return 0

    dest_id = sp_ensure_folder(h, drive["id"], SP_ARCHIVE_FOLDER)
    for f in files:
        r = requests.patch(f"{GRAPH}/drives/{drive['id']}/items/{f['id']}",
                           params={"@microsoft.graph.conflictBehavior": "replace"},
                           headers=h, timeout=60,
                           json={"parentReference": {"id": dest_id}, "name": f["name"]})
        _check(r, f"Moving {f['name']}")
        log.info("Moved %s -> %s/", f["name"], SP_ARCHIVE_FOLDER)
    log.info("Archived %d file(s)", len(files))
    return 0


def sharepoint_upload(path: Path) -> None:
    h = {"Authorization": f"Bearer {graph_token()}"}
    drive = sp_drive(h)

    folder = SP_FOLDER.strip("/")
    item_path = quote(f"{folder}/{path.name}" if folder else path.name)
    r = requests.post(
        f"{GRAPH}/drives/{drive['id']}/root:/{item_path}:/createUploadSession",
        headers=h, json={"item": {"@microsoft.graph.conflictBehavior": "replace"}}, timeout=60)
    _check(r, "Starting upload")
    upload_url = r.json()["uploadUrl"]  # pre-authorised: no token header on chunks

    data = path.read_bytes()
    total = len(data)
    for start in range(0, total, CHUNK):
        part = data[start:start + CHUNK]
        end = start + len(part) - 1
        r = requests.put(upload_url, data=part, timeout=300, headers={
            "Content-Length": str(len(part)),
            "Content-Range": f"bytes {start}-{end}/{total}"})
        if r.status_code not in (200, 201, 202):
            raise RuntimeError(f"Upload chunk failed ({r.status_code}): {r.text[:300]}")
    web_url = r.json().get("webUrl", "")
    log.info("Uploaded to SharePoint: %s/%s %s", SP_FOLDER, path.name, web_url)


# ---------- main ----------
def main() -> int:
    if not USER or not PASSWORD:
        log.error("VETBUDDY_USER / VETBUDDY_PASS missing - fill in the .env file")
        return 1

    today = dt.datetime.now(IST).date()
    d_from, d_to = mtd_range(today)

    for attempt in (1, 2, 3):
        try:
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
            xls_to_xlsx(data, tmp)
            tmp.replace(out)
            log.info("Saved %s (%.1f MB)", out, out.stat().st_size / 1e6)
            break
        except Exception as e:  # noqa: BLE001
            log.warning("Attempt %d failed: %s", attempt, e)
            if "Login failed" in str(e) or attempt == 3:
                log.error("Export FAILED for %s -> %s", d_from, d_to)
                return 1
            time.sleep(60)

    if not SP_ENABLED:
        return 0
    for attempt in (1, 2, 3):
        try:
            sharepoint_upload(out)
            return 0
        except Exception as e:  # noqa: BLE001
            log.warning("SharePoint upload attempt %d failed: %s", attempt, e)
            time.sleep(30)
    log.error("SharePoint upload FAILED (file was still generated)")
    return 1


def archive_main() -> int:
    if not SP_ENABLED:
        log.error("SharePoint settings (SP_...) missing - cannot archive")
        return 1
    for attempt in (1, 2, 3):
        try:
            return sharepoint_archive()
        except Exception as e:  # noqa: BLE001
            log.warning("Archive attempt %d failed: %s", attempt, e)
            time.sleep(30)
    log.error("Archive FAILED")
    return 1


if __name__ == "__main__":
    # python vetbuddy_sales_export.py            -> morning export + upload
    # python vetbuddy_sales_export.py --archive  -> end-of-day move to archive folder
    sys.exit(archive_main() if "--archive" in sys.argv else main())
