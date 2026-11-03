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
SP_MASTER_PATH = os.environ.get("SP_MASTER_PATH", "")  # e.g. "Vetbuddy Master Data.xlsx" (in SP_LIBRARY)
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


# ---------- master workbook: replace the month's rows ----------
# The master is very large (300k+ rows), so instead of loading it into memory we
# stream its sheet XML: copy every row, drop the rows whose AX date is in the
# report month, then append the new rows (A..AW values + AX =INT(B) formula).
# Styles are copied from the last kept row so the new rows look identical.
_ROW_RE = re.compile(rb"<row [^>]*/>|<row [^>]*[^/]>.*?</row>|<row>.*?</row>", re.S)
_AXV_RE = re.compile(rb'<c r="AX\d+"[^>]*?(?:/>|>(.*?)</c>)', re.S)
_V_RE = re.compile(rb"<v>([^<]*)</v>")
_CELL_S_RE = re.compile(rb'<c r="([A-Z]+)\d+"(?:[^>]*?\ss="(\d+)")?')
_EXCEL_EPOCH = dt.datetime(1899, 12, 30)


def _col_letter(i: int) -> str:  # 0 -> A
    s = ""
    i += 1
    while i:
        i, rem = divmod(i - 1, 26)
        s = chr(65 + rem) + s
    return s


def _xml_text(v: str) -> str:
    v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", v)
    return (v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def _is_num_cell(attrs) -> bool:
    """A cell holds a plain number (no type, or t="n")."""
    a = attrs or b""
    return b't="' not in a or b't="n"' in a


_BV_RE = re.compile(rb'<c r="B\d+"([^>]*?)(?:/>|>(.*?)</c>)', re.S)


def _row_month(row_xml: bytes):
    """(year, month) of the row, from column B (the real date+time from VetBuddy).
    Column AX is not used: its DATEVALUE(TEXT(...)) result depends on the
    regional settings of whoever last recalculated the file (day/month swaps)."""
    m = _BV_RE.search(row_xml)
    if m and m.group(2) and _is_num_cell(m.group(1)):
        v = _V_RE.search(m.group(2))
        if v:
            try:
                d = _EXCEL_EPOCH + dt.timedelta(days=float(v.group(1)))
                return (d.year, d.month)
            except (ValueError, OverflowError):
                pass
    # fallback: AX
    m = _AXV_RE.search(row_xml)
    if not m or not m.group(1):
        return None
    v = _V_RE.search(m.group(1))
    if not v:
        return None
    try:
        d = _EXCEL_EPOCH + dt.timedelta(days=float(v.group(1)))
        return (d.year, d.month)
    except (ValueError, OverflowError):
        return None


def _new_row_xml(r: int, vals: list, styles: dict, ncols: int) -> str:
    parts = [f'<row r="{r}" spans="1:{ncols + 1}">']
    for c in range(ncols):
        col = _col_letter(c)
        s = styles.get(col)
        sa = f' s="{s}"' if s else ""
        v = vals[c] if c < len(vals) else None
        if isinstance(v, dt.datetime):
            v = (v - _EXCEL_EPOCH).total_seconds() / 86400
        if v is None or v == "":
            parts.append(f'<c r="{col}{r}"{sa}/>')
        elif isinstance(v, bool):
            parts.append(f'<c r="{col}{r}"{sa} t="b"><v>{int(v)}</v></c>')
        elif isinstance(v, (int, float)):
            parts.append(f'<c r="{col}{r}"{sa}><v>{repr(v) if isinstance(v, float) else v}</v></c>')
        else:
            t = _xml_text(str(v))
            sp = ' xml:space="preserve"' if t != t.strip() else ""
            parts.append(f'<c r="{col}{r}"{sa} t="inlineStr"><is><t{sp}>{t}</t></is></c>')
    # AX: date without time, value pre-filled so it shows instantly
    b = vals[1] if len(vals) > 1 else None
    serial = (b - _EXCEL_EPOCH).total_seconds() / 86400 if isinstance(b, dt.datetime) else None
    ax = _col_letter(ncols)
    s = styles.get(ax)
    parts.append(_ax_cell(ax, r, s, serial))
    parts.append("</row>")
    return "".join(parts)


# AX formula: =INT(B) = the date of column B without the time. Unlike
# DATEVALUE(TEXT(B,"dd-mm-yyyy")) it is correct under any regional setting.
def _ax_cell(ax: str, r: int, s, b_serial) -> str:
    sa = f' s="{s}"' if s else ""
    v = f"<v>{int(b_serial)}</v>" if b_serial is not None else ""
    return f'<c r="{ax}{r}"{sa}><f>INT(B{r})</f>{v}</c>'


_AX_CELL_RE = re.compile(rb'<c r="AX(\d+)"([^>]*?)(?:/>|>.*?</c>)', re.S)


def _is_blank_row(row: bytes) -> bool:
    """True if the row has no values in any column (AX's formula is ignored)."""
    rest = _AX_CELL_RE.sub(b"", row)
    return b"<v>" not in rest and b"<is>" not in rest and b"<v " not in rest


def _fix_ax(row: bytes, r: int) -> bytes:
    """Rewrite an existing row's AX cell as =INT(Br) (keeping its style)."""
    m = _AX_CELL_RE.search(row)
    b_serial = None
    bm = _BV_RE.search(row)
    if bm and bm.group(2) and _is_num_cell(bm.group(1)):
        v = _V_RE.search(bm.group(2))
        if v:
            try:
                b_serial = float(v.group(1))
            except ValueError:
                pass
    if m:
        s = re.search(rb'\ss="(\d+)"', m.group(2))
        new = _ax_cell("AX", r, s.group(1).decode() if s else None, b_serial).encode()
        return row[:m.start()] + new + row[m.end():]
    if b_serial is None:
        return row
    # no AX cell yet: insert before AY (if any) or at the end of the row
    new = _ax_cell("AX", r, None, b_serial).encode()
    ay = re.search(rb'<c r="AY\d+"', row)
    i = ay.start() if ay else row.rfind(b"</row>")
    return row[:i] + new + row[i:]


def update_master_file(src_path: Path, dst_path: Path, rows: list, month: tuple) -> dict:
    """Rewrite the master workbook: remove rows whose AX date is in `month`
    (year, month), append `rows` (header first, then data) at the bottom."""
    import zipfile

    header = list(rows[0])
    while header and (header[-1] is None or str(header[-1]).strip() == ""):
        header.pop()  # the .xls carries empty trailing columns
    ncols = len(header)
    data = [list(r[:ncols]) for r in rows[1:]]
    zin = zipfile.ZipFile(src_path)

    # which part is the first sheet?
    wb_xml = zin.read("xl/workbook.xml").decode("utf-8")
    rels = zin.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    rid = re.search(r'<sheet [^>]*r:id="([^"]+)"', wb_xml).group(1)
    target = re.search(rf'<Relationship [^>]*Id="{rid}"[^>]*Target="([^"]+)"', rels) or \
        re.search(rf'<Relationship [^>]*Target="([^"]+)"[^>]*Id="{rid}"', rels)
    sheet_part = "xl/" + target.group(1).lstrip("/").replace("xl/", "", 1)

    # header check: master columns A.. must match the export
    raw_head = b""
    with zin.open(sheet_part) as f:
        while b"</row>" not in raw_head:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            raw_head += chunk
    ss = []
    if "xl/sharedStrings.xml" in zin.namelist():
        from xml.etree.ElementTree import iterparse
        ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        for _, el in iterparse(zin.open("xl/sharedStrings.xml")):
            if el.tag == ns + "si":
                ss.append("".join(el.itertext()))
                el.clear()
    first_row = _ROW_RE.search(raw_head).group(0).decode("utf-8")
    master_head = []
    for m in re.finditer(r'<c r="([A-Z]+)1"([^>]*?)(?:/>|>(.*?)</c>)', first_row, re.S):
        attrs, inner = m.group(2), m.group(3) or ""
        v = re.search(r"<v>([^<]*)</v>", inner)
        t = re.search(r"<t[^>]*>([^<]*)</t>", inner)
        if 't="s"' in attrs and v:
            master_head.append(ss[int(v.group(1))])
        elif t:
            master_head.append(t.group(1))
        else:
            master_head.append(v.group(1) if v else "")
    exp = [str(h).strip().lower() for h in header]
    got = [h.strip().lower() for h in master_head[:ncols]]
    if exp != got:
        diff = [(i, a, b) for i, (a, b) in enumerate(zip(exp, got)) if a != b][:5]
        raise RuntimeError(f"Master columns don't match the export (first differences: {diff}) "
                           "- master NOT changed")

    stats = {"removed": 0, "added": len(data), "kept": 0}
    last_kept_r = 1
    last_kept_xml = b""
    style_votes: dict = {}
    style_votes_n = 0
    pending_blank: list = []
    pending_blank_dropped = 0
    seen_target = False

    tmp_sheet = dst_path.with_name(dst_path.name + ".sheet.tmp")
    with zin.open(sheet_part) as f, open(tmp_sheet, "wb") as out:
        buf = b""
        prefix_done = False
        tail = b""
        while True:
            chunk = f.read(16 << 20)
            data_ = buf + chunk
            if not prefix_done:
                i = data_.find(b"<sheetData>")
                if i == -1:
                    i2 = data_.find(b"<sheetData/>")
                    if i2 != -1:  # empty sheet
                        data_ = data_.replace(b"<sheetData/>", b"<sheetData></sheetData>", 1)
                        i = data_.find(b"<sheetData>")
                if i == -1:
                    if not chunk:
                        raise RuntimeError("Master sheet has no data section")
                    buf = data_
                    continue
                out.write(data_[: i + len(b"<sheetData>")])
                data_ = data_[i + len(b"<sheetData>"):]
                prefix_done = True
            end = data_.find(b"</sheetData>")
            limit = end if end != -1 else data_.rfind(b"</row>") + 6
            pos = 0
            for m in _ROW_RE.finditer(data_, 0, max(limit, 0)):
                row = m.group(0)
                r = int(re.search(rb'r="(\d+)"', row).group(1))
                if r > 1 and _is_blank_row(row):
                    # empty row (e.g. cleared instead of deleted): keep it only if real
                    # data follows; trailing empty rows are dropped so the new data
                    # goes directly under the last real row
                    pending_blank.append(row)
                    pos = m.end()
                    continue
                if r > 1 and _row_month(row) == month:
                    pending_blank_dropped += len(pending_blank)
                    pending_blank.clear()
                    if style_votes_n < 3000:  # style template: the rows being replaced
                        style_votes_n += 1
                        for cm in _CELL_S_RE.finditer(row):
                            key = (cm.group(1).decode(), cm.group(2).decode() if cm.group(2) else None)
                            style_votes[key] = style_votes.get(key, 0) + 1
                    seen_target = True
                    stats["removed"] += 1
                else:
                    if seen_target and r > 1:
                        raise RuntimeError(
                            f"Unexpected layout: row {r} (another month) comes after "
                            f"{month[1]:02d}/{month[0]} rows - master NOT changed")
                    for b in pending_blank:  # empty rows in the middle of data: keep
                        out.write(b)
                    pending_blank.clear()
                    if r > 1:
                        row = _fix_ax(row, r)  # AX -> =INT(B), correct in any locale
                    out.write(row)
                    stats["kept"] += 1
                    last_kept_r, last_kept_xml = r, row
                pos = m.end()
            if end != -1:
                tail = data_[end:] + f.read()
                break
            buf = data_[pos:]
            if not chunk:
                raise RuntimeError("Master sheet XML ended unexpectedly")

        stats["empty_rows_dropped"] = pending_blank_dropped + len(pending_blank)
        pending_blank.clear()

        # styles to reuse: from the month's old rows if there were any (same look as
        # before), otherwise from the last kept data row
        if style_votes:  # most common style per column among the replaced rows
            styles = {}
            for (col, s), n in sorted(style_votes.items(), key=lambda kv: kv[1]):
                styles[col] = s
        else:
            tmpl = last_kept_xml if last_kept_r > 1 else b""
            styles = {m.group(1).decode(): (m.group(2).decode() if m.group(2) else None)
                      for m in _CELL_S_RE.finditer(tmpl)}
        r = last_kept_r
        new_xml = []
        for vals in data:
            r += 1
            new_xml.append(_new_row_xml(r, vals, styles, ncols))
        last_row = r
        # safety: the new rows must be valid XML before anything is uploaded
        from xml.etree import ElementTree as ET
        try:
            parsed = ET.fromstring('<sheetData xmlns="http://schemas.openxmlformats.org/'
                                   'spreadsheetml/2006/main">' + "".join(new_xml) + "</sheetData>")
        except ET.ParseError as e:
            raise RuntimeError(f"Generated rows are not valid ({e}) - master NOT changed") from e
        if len(parsed) != len(data):
            raise RuntimeError("Generated row count mismatch - master NOT changed")
        for x in new_xml:
            out.write(x.encode("utf-8"))

        # fix the sheet's used range and filter range
        tail_s = tail.decode("utf-8")
        tail_s = re.sub(r'(<autoFilter ref=")([A-Z]+)1:([A-Z]+)\d+',
                        lambda m: f"{m.group(1)}{m.group(2)}1:{m.group(3)}{last_row}", tail_s, 1)
        out.write(tail_s.encode("utf-8"))
    stats["last_row"] = last_row

    # rebuild the zip: new sheet, updated workbook.xml, no calcChain (Excel rebuilds it)
    with zipfile.ZipFile(dst_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zout:
        for item in zin.infolist():
            name = item.filename
            if name == "xl/calcChain.xml":
                continue
            if name == sheet_part:
                with open(tmp_sheet, "rb") as fsrc:
                    head = fsrc.read(1 << 20)
                    head = re.sub(rb'<dimension ref="([A-Z]+)1:([A-Z]+)\d+"/>',
                                  lambda m: b'<dimension ref="%s1:%s%d"/>' % (m.group(1), m.group(2), last_row),
                                  head, 1)
                    with zout.open(item.filename, "w", force_zip64=True) as zf:
                        zf.write(head)
                        while True:
                            b = fsrc.read(16 << 20)
                            if not b:
                                break
                            zf.write(b)
                continue
            content = zin.read(name)
            if name == "xl/workbook.xml":
                s = content.decode("utf-8")
                s = re.sub(r"(_xlnm\._FilterDatabase[^>]*>[^<]*!\$[A-Z]+\$1:\$[A-Z]+\$)\d+",
                           lambda m: f"{m.group(1)}{last_row}", s)
                if "<calcPr" in s:
                    s = re.sub(r"<calcPr([^>]*?)\s*fullCalcOnLoad=\"[^\"]*\"", r"<calcPr\1", s)
                    s = s.replace("<calcPr", '<calcPr fullCalcOnLoad="1"', 1)
                else:
                    s = s.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>')
                content = s.encode("utf-8")
            elif name == "xl/_rels/workbook.xml.rels":
                content = re.sub(rb'<Relationship [^>]*calcChain[^>]*/>', b"", content)
            elif name == "[Content_Types].xml":
                content = re.sub(rb'<Override [^>]*calcChain[^>]*/>', b"", content)
            zout.writestr(item, content)
    tmp_sheet.unlink()
    zin.close()
    return stats


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


def sharepoint_upload(path: Path) -> None:
    h = {"Authorization": f"Bearer {graph_token()}"}
    drive = sp_drive(h)
    folder = SP_FOLDER.strip("/")
    res = sp_put_file(h, drive["id"], path, f"{folder}/{path.name}" if folder else path.name)
    log.info("Uploaded to SharePoint: %s/%s %s", SP_FOLDER, path.name, res.get("webUrl", ""))


def sharepoint_update_master(rows: list, month: tuple) -> None:
    """Download the master workbook, replace `month` rows with `rows`, upload it back."""
    h = {"Authorization": f"Bearer {graph_token()}"}
    drive = sp_drive(h)
    path = SP_MASTER_PATH.strip("/")
    r = requests.get(f"{GRAPH}/drives/{drive['id']}/root:/{quote(path)}", headers=h, timeout=60)
    _check(r, f"Finding master file '{path}'")
    item = r.json()
    etag = item.get("eTag", "")
    work = OUTPUT_DIR / "_master_work"
    work.mkdir(parents=True, exist_ok=True)
    src, dst = work / "master_in.xlsx", work / "master_out.xlsx"
    log.info("Downloading master '%s' (%.0f MB)...", path, item.get("size", 0) / 1e6)
    with requests.get(f"{GRAPH}/drives/{drive['id']}/items/{item['id']}/content",
                      headers=h, stream=True, timeout=600) as resp:
        _check(resp, "Downloading master")
        with open(src, "wb") as f:
            for b in resp.iter_content(1 << 20):
                f.write(b)
    stats = update_master_file(src, dst, rows, month)
    log.info("Master: removed %d rows of %02d/%d, removed %d empty rows, added %d rows "
             "(now %d rows incl. header)", stats["removed"], month[1], month[0],
             stats["empty_rows_dropped"], stats["added"], stats["last_row"])
    try:
        sp_put_file(h, drive["id"], dst, path, if_match=etag)
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
            rows = xls_to_xlsx(data, tmp)
            tmp.replace(out)
            log.info("Saved %s (%.1f MB, %d data rows)", out, out.stat().st_size / 1e6, len(rows) - 1)
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
            break
        except Exception as e:  # noqa: BLE001
            log.warning("SharePoint upload attempt %d failed: %s", attempt, e)
            if attempt == 3:
                log.error("SharePoint upload FAILED (file was still generated)")
                return 1
            time.sleep(30)

    if not SP_MASTER_PATH:
        log.warning("Master sheet NOT updated: SP_MASTER_PATH is not set "
                    "(GitHub variable missing, or the workflow file doesn't pass it)")
        return 0
    if len(rows) < 2:
        log.error("Report has no data rows - master NOT changed")
        return 1
    month = (d_from.year, d_from.month)
    # The master can't be replaced while someone has it open (desktop Excel or
    # Excel for the web in edit mode). Keep trying for ~30 minutes.
    attempts = 7
    for attempt in range(1, attempts + 1):
        try:
            sharepoint_update_master(rows, month)
            return 0
        except Exception as e:  # noqa: BLE001
            log.warning("Master update attempt %d/%d failed: %s", attempt, attempts, e)
            if "NOT changed" in str(e) or attempt == attempts:
                break
            time.sleep(300)
    log.error("Master update FAILED - report is still in %s", SP_FOLDER)
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
