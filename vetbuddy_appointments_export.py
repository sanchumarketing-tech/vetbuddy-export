#!/usr/bin/env python3
"""
VetBuddy "Appointment Status" daily export -> SharePoint master (Sanchu Animal Hospital).

Every morning (GitHub Actions, 7:23 AM IST), for YESTERDAY (IST):
  1. Logs in to VetBuddy and makes the same report as
     Settings -> Business Intelligence -> Appointment Status -> date range = yesterday,
     all units (clinics), status All, type All -> Generate Report -> Create XLS.
  2. Saves the day's rows (title rows removed) as
     VetBuddy_AppointmentStatus_<day>.xlsx in <Sales Reports Sanchu>/Appointment Status Archive.
  3. Appends the rows to the master "Appointment Status.xlsx" (sanchureports OneDrive ->
     Sanchu Reports), sheet "Sheet1", directly under the last row, exactly as done by hand:
       A-S  the 19 export columns
       T    Created Date  =DATEVALUE(TEXT(Br,"dd-mm-yyyy"))
       U    Date          =DATEVALUE(MID(Cr,5,2)&"-"&LEFT(Cr,3)&"-"&MID(Cr,8,4))  (appointment date)
     The other sheets (Next day, OLD DUMP, Full Month) are not touched.

The master is ~80 MB (over 100,000 rows, plus a 400,000-row OLD DUMP sheet), too big to open
with openpyxl, so Sheet1 is edited directly in the file (like master_sheet.py for the sales master).

A day already in the master (most of the day's appointment IDs are already there with that
Date in column U) is skipped. --if-present replace rewrites it, but only if that day's rows
are the last rows of Sheet1 (i.e. the most recent day added).

Safety: the master's headers A-U are checked first; on any difference nothing is changed.
The master is saved only if nobody changed it meanwhile; if it is open/locked, the run retries
every minute for 30 minutes.

Environment (GitHub secrets / variables, or a .env file):
  VETBUDDY_USER, VETBUDDY_PASS                    VetBuddy login (same as the sales job)
  SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET    Azure app (same as the other jobs)
  SP_SITE_URL, SP_LIBRARY                         where the archive folder lives (Sales Reports Sanchu)
  SP_APPT_ARCHIVE_FOLDER   default "Appointment Status Archive"
  SP_APPT_SITE_URL         default https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in
  SP_APPT_LIBRARY          default "Documents"
  SP_APPT_MASTER_PATH      default "Sanchu Reports/Appointment Status.xlsx"
  SP_APPT_SHEET            default "Sheet1"
  SP_APPT_IF_PRESENT       skip (default) | replace
  OUTPUT_DIR               local folder for the files (default ./reports)

Usage:
  python vetbuddy_appointments_export.py                                # yesterday (IST)
  python vetbuddy_appointments_export.py --date 2026-11-09
  python vetbuddy_appointments_export.py --from 2026-11-06 --to 2026-11-09   # catch up, oldest first
  python vetbuddy_appointments_export.py --date 2026-11-09 --if-present replace
  python vetbuddy_appointments_export.py --date 2026-11-09 --file-only      # no master update
"""

import argparse
import datetime as dt
import math
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

import requests

# Shared VetBuddy login + SharePoint helpers (also loads .env and sets up logging)
import vetbuddy_sales_export as vb
from master_sheet import (_CELL_S_RE, _V_RE, _cell_re, _row_num, _xml_text, cell_value,
                          col_letter, shared_strings, stream_sheet)

log = vb.log
IST = vb.IST
REPORT_PAGE = "appointment_status_report.php"
REPORT_URL = f"{vb.BASE}/sanchu/{REPORT_PAGE}"
EPOCH = dt.datetime(1899, 12, 30)

# The export's columns (A-S), in order. The master has the same, plus T and U.
EXPORT_COLUMNS = ["Appointment ID", "Creation Time", "Appointment Time", "Client", "Patient",
                  "Phone", "Email", "Status", "Appointment Type", "Complaint", "Resource Details",
                  "Created By", "Edited By", "Reason For Cancellation", "Cancelled By",
                  "Cancelled On", "Clinic", "Next Appointment", "Future Custom Reminders"]
NCOLS = len(EXPORT_COLUMNS)                   # 19 = A..S
COL_T, COL_U = "T", "U"
MASTER_EXTRA = {COL_T: "Created Date", COL_U: "Date"}
LAST_COL = COL_U
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

ARCHIVE_FOLDER = os.environ.get("SP_APPT_ARCHIVE_FOLDER", "") or "Appointment Status Archive"
APPT_SITE_URL = (os.environ.get("SP_APPT_SITE_URL", "")
                 or "https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in")
APPT_LIBRARY = os.environ.get("SP_APPT_LIBRARY", "") or "Documents"
APPT_MASTER_PATH = os.environ.get("SP_APPT_MASTER_PATH", "") or "Sanchu Reports/Appointment Status.xlsx"
APPT_SHEET = os.environ.get("SP_APPT_SHEET", "") or "Sheet1"


class AlreadyPresent(Exception):
    pass


class Locked(Exception):
    pass


class Changed(Exception):
    pass


# ============================================================== VetBuddy report
def wait_until_free(s: requests.Session, tries: int = 20) -> None:
    for _ in range(tries):
        r = s.get(f"{vb.BASE}/sanchu/statcheck.php",
                  params={"filename": REPORT_PAGE, "_": int(time.time() * 1000)}, timeout=60)
        if "busy" not in r.text.lower():
            return
        log.info("VetBuddy says the report is busy, waiting 30s...")
        time.sleep(30)
    raise RuntimeError("Report generator stayed busy for too long")


def download_xls(s: requests.Session, day: dt.date) -> bytes:
    """Appointment Status report for one day, all clinics, all statuses, all types (.xls)."""
    form = {
        "pendingemr": "",
        "from": day.strftime("%m/%d/%Y"), "tod": day.strftime("%m/%d/%Y"),
        "selclinic": "All", "lstapptype": "All", "apptypeother": "all",
        "cmdxls": "Create XLS",
    }
    wait_until_free(s)
    log.info("Requesting Appointment Status report for %s (all clinics)...", day)
    r = s.post(REPORT_URL, data=form, timeout=900)
    m = re.search(r'href="(doc/[^"]+\.xls)"', r.text, re.I)
    if not m:
        raise RuntimeError("Report page did not return an XLS link (session expired or layout changed)")
    f = s.get(f"{vb.BASE}/sanchu/{m.group(1)}", timeout=600)
    f.raise_for_status()
    if not f.content.startswith(vb.XLS_MAGIC):
        raise RuntimeError("Downloaded file is not an Excel file")
    return f.content


def parse_xls(xls_bytes: bytes) -> list:
    """-> list of data rows (19 values each). Title rows above the header are dropped.
    Dates (Creation Time, sometimes Next Appointment) stay Excel serial numbers."""
    import xlrd
    book = xlrd.open_workbook(file_contents=xls_bytes)
    sh = book.sheet_by_index(0)
    head = next((r for r in range(min(sh.nrows, 30))
                 if str(sh.cell_value(r, 0)).strip().lower() == "appointment id"), None)
    if head is None:
        raise RuntimeError("'Appointment ID' header not found in the report - layout changed?")
    got = [str(sh.cell_value(head, c)).strip() for c in range(min(sh.ncols, NCOLS))]
    if [g.lower() for g in got] != [e.lower() for e in EXPORT_COLUMNS]:
        raise RuntimeError(f"Report columns changed: {got}")
    rows = []
    for r in range(head + 1, sh.nrows):
        if sh.cell_type(r, 0) not in (xlrd.XL_CELL_NUMBER, xlrd.XL_CELL_TEXT) \
                or not str(sh.cell_value(r, 0)).strip():
            continue  # blank or summary line
        vals = []
        for c in range(NCOLS):
            cell = sh.cell(r, c)
            v = cell.value
            if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                v = None
            elif cell.ctype == xlrd.XL_CELL_DATE:
                v = ("date", float(v))
            elif cell.ctype == xlrd.XL_CELL_NUMBER:
                v = int(v) if v == int(v) and abs(v) < 1e15 else v
            elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                v = bool(v)
            elif cell.ctype == xlrd.XL_CELL_ERROR:
                v = None
            else:
                v = str(v)
                if v == "":
                    v = None
            vals.append(v)
        rows.append(vals)
    return rows


def appt_date(text):
    """'Nov 09 2026 12:40am - 01:10am' -> date(2026, 11, 9) (same as the master's U formula)."""
    t = str(text or "")
    try:
        return dt.date(int(t[7:11]), MONTHS[t[0:3].lower()], int(t[4:6]))
    except (KeyError, ValueError):
        return None


def serial_of(d: dt.date) -> int:
    return (dt.datetime(d.year, d.month, d.day) - EPOCH).days


def plain(v):
    return v[1] if isinstance(v, tuple) else v


def write_day_xlsx(rows: list, dest: Path) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook()
    ws = wb.active
    ws.title = "Appointment Status"
    ws.append(EXPORT_COLUMNS)
    for c in ws[1]:
        c.font = Font(bold=True)
    for vals in rows:
        out = []
        for v in vals:
            if isinstance(v, tuple):
                out.append(EPOCH + dt.timedelta(days=v[1]))
            else:
                out.append(v)
        ws.append(out)
    for r in range(2, ws.max_row + 1):
        for col in ("B", "R"):
            if isinstance(ws[f"{col}{r}"].value, dt.datetime):
                ws[f"{col}{r}"].number_format = "dd-mm-yyyy hh:mm"
    ws.freeze_panes = "A2"
    widths = [12, 20, 30, 28, 24, 13, 28, 20, 18, 22, 32, 16, 16, 22, 14, 14, 40, 14, 36]
    for i, w in enumerate(widths):
        ws.column_dimensions[col_letter(i)].width = w
    wb.save(dest)


# ============================================================== master workbook
def _sheet_part(z: zipfile.ZipFile, sheet_name: str):
    """-> (zip part of the sheet, its index in the workbook)."""
    wb = z.read("xl/workbook.xml").decode("utf-8")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    sheets = re.findall(r"<sheet [^>]*>", wb)
    names = []
    for i, tag in enumerate(sheets):
        name = re.search(r'name="([^"]*)"', tag).group(1)
        names.append(name)
        if name.strip().lower() == sheet_name.strip().lower():
            rid = re.search(r'r:id="([^"]+)"', tag).group(1)
            m = re.search(rf'<Relationship [^>]*Id="{rid}"[^>]*Target="([^"]+)"', rels) or \
                re.search(rf'<Relationship [^>]*Target="([^"]+)"[^>]*Id="{rid}"', rels)
            target = m.group(1)
            part = target.lstrip("/") if target.startswith("/") else "xl/" + target
            return part, i
    raise RuntimeError(f"Sheet '{sheet_name}' not found in the master. Sheets: {names}")


def _num(row: bytes, col: str):
    """Cached number of a cell (formula result included), else None."""
    m = _cell_re(col).search(row)
    if not m or not m.group(2):
        return None
    a = m.group(1) or b""
    if b't="' in a and b't="n"' not in a:
        return None
    v = _V_RE.search(m.group(2))
    try:
        return float(v.group(1)) if v else None
    except ValueError:
        return None


def _is_blank(row: bytes) -> bool:
    return b"<v>" not in row and b"<is>" not in row and b"<v " not in row


def _cell(col, r, style, v) -> str:
    sa = f' s="{style}"' if style else ""
    if v is None or v == "":
        return f'<c r="{col}{r}"{sa}/>' if style else ""
    if isinstance(v, bool):
        return f'<c r="{col}{r}"{sa} t="b"><v>{int(v)}</v></c>'
    if isinstance(v, (int, float)):
        return f'<c r="{col}{r}"{sa}><v>{repr(v) if isinstance(v, float) else v}</v></c>'
    t = _xml_text(str(v))
    sp = ' xml:space="preserve"' if t != t.strip() else ""
    return f'<c r="{col}{r}"{sa} t="inlineStr"><is><t{sp}>{t}</t></is></c>'


def new_row_xml(r: int, vals: list, styles: dict) -> str:
    parts = [f'<row r="{r}" spans="1:21">']
    for c in range(NCOLS):
        col = col_letter(c)
        v = vals[c]
        style = styles.get(col)
        if isinstance(v, tuple):          # a date (Creation Time, Next Appointment)
            if col != "B":
                style = styles.get("_date") or style
            v = v[1]
        parts.append(_cell(col, r, style, v))
    b = plain(vals[1])
    st, su = styles.get(COL_T), styles.get(COL_U)
    sa_t, sa_u = (f' s="{st}"' if st else ""), (f' s="{su}"' if su else "")
    f_t = _xml_text(f'DATEVALUE(TEXT(B{r},"dd-mm-yyyy"))')
    v_t = f"<v>{math.floor(b)}</v>" if isinstance(b, (int, float)) else ""
    parts.append(f'<c r="T{r}"{sa_t}><f>{f_t}</f>{v_t}</c>')
    f_u = _xml_text(f'DATEVALUE(MID(C{r},5,2)&"-"&LEFT(C{r},3)&"-"&MID(C{r},8,4))')
    d = appt_date(vals[2])
    if d:
        parts.append(f'<c r="U{r}"{sa_u}><f>{f_u}</f><v>{serial_of(d)}</v></c>')
    else:
        parts.append(f'<c r="U{r}"{sa_u} t="e"><f>{f_u}</f><v>#VALUE!</v></c>')
    parts.append("</row>")
    return "".join(parts)


def last_block_start(recent, day_serial: int):
    """First row of the block pasted for `day_serial`, if that block is the LAST one in the
    sheet; else None. A day's paste also carries a few appointments dated later days
    ("strays"), so the block = rows from the first row dated that day, where every later row
    is dated that day or later and most of them are dated that day."""
    rows = list(recent)
    if not rows:
        return None
    start = None
    for i in range(len(rows) - 1, -1, -1):  # walk back while rows are dated that day or later
        u = rows[i][1]
        if u is None or u < day_serial:
            break
        if u == day_serial:
            start = i
    if start is None:
        return None
    after = rows[start:]
    own = sum(1 for _, u in after if u == day_serial)
    if own < 0.75 * len(after):        # the last block belongs to a later day
        return None
    # Rows dated later just BEFORE the block are left alone: they may be the previous day's
    # strays, and deleting them would lose data (keeping them at worst duplicates a stray).
    return rows[start][0]


def _copy_entry(zin, zout, item, data: bytes = None):
    zi = zipfile.ZipInfo(item.filename, date_time=item.date_time)
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = item.external_attr
    if data is not None:
        zout.writestr(zi, data)
        return
    with zin.open(item) as src, zout.open(zi, "w", force_zip64=True) as dst:
        shutil.copyfileobj(src, dst, 16 << 20)


def update_master_file(src_path: Path, dst_path: Path, days: list, if_present: str = "skip",
                       sheet_name: str = APPT_SHEET) -> dict:
    """days = [(date, rows), ...] oldest first. Appends each day's rows under the last row of
    the sheet. Returns {"added": {day: n}, "skipped": [days], "replaced": {day: n}, "last_row": n}."""
    zin = zipfile.ZipFile(src_path)
    part, sheet_idx = _sheet_part(zin, sheet_name)
    ss = shared_strings(zin)

    # ---- 1. header check
    head_row = next(b for kind, b in stream_sheet(zin, part) if kind == "row")
    expected = [h.lower() for h in EXPORT_COLUMNS] + [MASTER_EXTRA[COL_T].lower(), MASTER_EXTRA[COL_U].lower()]
    got = [str(cell_value(head_row, col_letter(i), ss) or "").strip().lower() for i in range(len(expected))]
    if got != expected:
        diff = [(col_letter(i), e, g) for i, (e, g) in enumerate(zip(expected, got)) if e != g][:5]
        raise RuntimeError(f"Master headers don't match (column, expected, found): {diff} - master NOT changed")

    # ---- 2. first pass: which days are present, where the last day starts, style template
    want = {d: {str(plain(v[0])) for v in rows if appt_date(v[2]) == d} for d, rows in days}
    found = {d: set() for d, _ in days}
    from collections import deque
    recent = deque(maxlen=20000)  # (row, U) of the last rows: to find the last day's block
    last_data_r, template = 1, b""
    serials = {serial_of(d): d for d, _ in days}
    date_style = None
    for kind, row in stream_sheet(zin, part):
        if kind != "row":
            continue
        r = _row_num(row)
        if r == 1 or _is_blank(row):
            continue
        last_data_r, template = r, row
        u = _num(row, COL_U)
        if u is not None:
            u = int(u)
            if u in serials:
                aid = _num(row, "A")
                if aid is not None:
                    found[serials[u]].add(str(int(aid)))
        recent.append((r, u))
        if date_style is None and _num(row, "R") is not None:
            m = _cell_re("R").search(row)
            s = re.search(rb'\ss="(\d+)"', m.group(1) or b"")
            date_style = s.group(1).decode() if s else None

    styles = {m.group(1).decode(): (m.group(2).decode() if m.group(2) else None)
              for m in _CELL_S_RE.finditer(template)}
    styles["_date"] = date_style or styles.get(COL_T)

    result = {"added": {}, "skipped": [], "replaced": {}}
    cut_from = None              # rows >= cut_from are removed (replace of the last day)
    to_add = []
    for d, rows in days:
        core = want[d]
        present = bool(core) and len(found[d] & core) >= max(1, len(core) // 2)
        if present and if_present != "replace":
            result["skipped"].append(d)
            continue
        if present:
            start = None if cut_from is not None else last_block_start(recent, serial_of(d))
            if start is None:
                raise RuntimeError(f"{d} is already in the master but it is not the last day added "
                                   f"(only the most recent day can be replaced) - master NOT changed")
            cut_from = start
            result["replaced"][d] = last_data_r - start + 1
        to_add.append((d, rows))
    if not to_add:
        zin.close()
        raise AlreadyPresent()

    # ---- 3. second pass: write the sheet
    tmp = dst_path.with_name(dst_path.name + ".sheet.tmp")
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    last_kept = 1
    pending_blank = []
    with open(tmp, "wb") as out:
        tail = b""
        for kind, row in stream_sheet(zin, part):
            if kind == "prefix":
                out.write(row)
                continue
            if kind == "tail":
                tail = row
                break
            r = _row_num(row)
            if cut_from is not None and r >= cut_from:
                continue
            if r > 1 and _is_blank(row):
                pending_blank.append(row)       # empty rows at the bottom are dropped
                continue
            for b in pending_blank:
                out.write(b)
            pending_blank.clear()
            out.write(row)
            last_kept = r
        r = last_kept
        new_rows = []
        for d, rows in to_add:
            for vals in rows:
                r += 1
                new_rows.append(new_row_xml(r, vals, styles))
            result["added"][d] = len(rows)
        from xml.etree import ElementTree as ET
        try:  # the new rows must be valid XML before anything is written back
            ET.fromstring('<sheetData xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                          + "".join(new_rows) + "</sheetData>")
        except ET.ParseError as e:
            raise RuntimeError(f"Generated rows are not valid ({e}) - master NOT changed") from e
        for x in new_rows:
            out.write(x.encode("utf-8"))
        last_row = r
        t = tail.decode("utf-8")
        t = re.sub(r'(<autoFilter ref="[A-Z]+1:[A-Z]+)\d+', lambda m: f"{m.group(1)}{last_row}", t, 1)
        out.write(t.encode("utf-8"))
    result["last_row"] = last_row

    # ---- 4. rebuild the .xlsx (other sheets byte-for-byte; calcChain dropped, Excel rebuilds it)
    with zipfile.ZipFile(dst_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zout:
        for item in zin.infolist():
            name = item.filename
            if name == "xl/calcChain.xml":
                continue
            if name == part:
                zi = zipfile.ZipInfo(name, date_time=item.date_time)
                zi.compress_type = zipfile.ZIP_DEFLATED
                with open(tmp, "rb") as fsrc, zout.open(zi, "w", force_zip64=True) as zf:
                    head = fsrc.read(1 << 20)
                    head = re.sub(rb'(<dimension ref="[A-Z]+1:[A-Z]+)\d+',
                                  lambda m: m.group(1) + str(last_row).encode(), head, 1)
                    zf.write(head)
                    shutil.copyfileobj(fsrc, zf, 16 << 20)
                continue
            if name == "xl/workbook.xml":
                s = zin.read(name).decode("utf-8")
                s = re.sub(rf'(<definedName name="_xlnm\._FilterDatabase" localSheetId="{sheet_idx}"[^>]*>'
                           rf'[^<]*!\$[A-Z]+\$1:\$[A-Z]+\$)\d+',
                           lambda m: f"{m.group(1)}{last_row}", s)
                _copy_entry(zin, zout, item, s.encode("utf-8"))
            elif name == "xl/_rels/workbook.xml.rels":
                _copy_entry(zin, zout, item, re.sub(rb"<Relationship [^>]*calcChain[^>]*/>", b"", zin.read(name)))
            elif name == "[Content_Types].xml":
                _copy_entry(zin, zout, item, re.sub(rb"<Override [^>]*calcChain[^>]*/>", b"", zin.read(name)))
            else:
                _copy_entry(zin, zout, item)
    tmp.unlink()
    zin.close()
    return result


# ============================================================== SharePoint
def graph_headers() -> dict:
    return {"Authorization": f"Bearer {vb.graph_token()}"}


def download_master(h: dict, drive: dict, dest: Path) -> dict:
    path = APPT_MASTER_PATH.strip("/")
    r = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/root:/{quote(path)}", headers=h, timeout=60)
    vb._check(r, f"Finding master file '{path}'")
    item = r.json()
    dest.parent.mkdir(parents=True, exist_ok=True)
    log.info("Downloading master '%s' (%.0f MB)...", path, item.get("size", 0) / 1e6)
    with requests.get(f"{vb.GRAPH}/drives/{drive['id']}/items/{item['id']}/content",
                      headers=h, stream=True, timeout=900) as resp:
        vb._check(resp, "Downloading master")
        with open(dest, "wb") as f:
            for b in resp.iter_content(1 << 20):
                f.write(b)
    return item


def update_master(days: list, if_present: str, work: Path) -> dict:
    for attempt in range(1, 31):
        h = graph_headers()
        drive = vb.sp_drive(h, APPT_SITE_URL, APPT_LIBRARY)
        src, dst = work / "appt_master_in.xlsx", work / "appt_master_out.xlsx"
        item = download_master(h, drive, src)
        try:
            res = update_master_file(src, dst, days, if_present)
            log.info("Saving master (%.0f MB)...", dst.stat().st_size / 1e6)
            vb.sp_put_file(h, drive["id"], dst, APPT_MASTER_PATH.strip("/"), if_match=item.get("eTag", ""))
            return res
        except RuntimeError as e:
            msg = str(e)
            if "412" in msg:
                log.warning("Master changed while updating (attempt %d/30); retrying with the latest copy",
                            attempt)
            elif "423" in msg or "resourceLocked" in msg or "nameAlreadyExists" in msg:
                log.warning("Master is open/locked by someone (attempt %d/30); retrying in 60s", attempt)
                time.sleep(60)
            else:
                raise
        finally:
            for p in (src, dst):
                p.unlink(missing_ok=True)
    raise RuntimeError("Could not save the master (it stayed open or kept changing for 30 minutes). "
                       "Close it and run the workflow again.")


def archive(path: Path) -> None:
    h = graph_headers()
    drive = vb.sp_drive(h)
    folder = ARCHIVE_FOLDER.strip("/")
    vb.sp_ensure_folder(h, drive["id"], folder)
    vb.sp_put_file(h, drive["id"], path, f"{folder}/{path.name}")
    log.info("Archived %s in '%s'", path.name, folder)


# ============================================================== main
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="VetBuddy Appointment Status -> SharePoint master")
    p.add_argument("--date", help="day to add, YYYY-MM-DD (default: yesterday, IST)")
    p.add_argument("--from", dest="d_from", help="first day of a catch-up range, YYYY-MM-DD")
    p.add_argument("--to", dest="d_to", help="last day of a catch-up range (default: yesterday)")
    p.add_argument("--if-present", choices=["skip", "replace"],
                   default=os.environ.get("SP_APPT_IF_PRESENT", "") or "skip")
    p.add_argument("--file-only", action="store_true", help="only make/archive the file(s)")
    a = p.parse_args(argv)

    yesterday = dt.datetime.now(IST).date() - dt.timedelta(days=1)
    try:
        if a.date:
            first = last = dt.date.fromisoformat(a.date)
        else:
            first = dt.date.fromisoformat(a.d_from) if a.d_from else yesterday
            last = dt.date.fromisoformat(a.d_to) if a.d_to else yesterday
        if first > last:
            raise ValueError("--from is after --to")
        if last > yesterday:
            raise ValueError("only past days can be added (the day must be over)")
        if (last - first).days > 62:
            raise ValueError("at most 2 months per run")
    except ValueError as e:
        log.error("Bad date: %s", e)
        return 1
    if not vb.USER or not vb.PASSWORD:
        log.error("VETBUDDY_USER / VETBUDDY_PASS missing")
        return 1

    vb.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    status = 0
    days = []

    # 1-2. VetBuddy -> day file(s) -> archive
    sess = {}

    def session():
        if "s" not in sess:
            s = requests.Session()
            s.headers["User-Agent"] = "Mozilla/5.0 (VetBuddy appointment export)"
            vb.login(s)
            sess["s"] = s
        return sess["s"]

    d = first
    while d <= last:
        got = {}

        def fetch(day=d):
            try:
                got["rows"] = parse_xls(download_xls(session(), day))
            except Exception:
                sess.pop("s", None)    # log in again on the next attempt
                raise

        if not vb.retry(f"Appointment report {d}", fetch, 3, 60):
            log.error("Appointment Status export FAILED for %s", d)
            return 1
        rows = got["rows"]
        own = sum(1 for v in rows if appt_date(v[2]) == d)
        log.info("%s: %d appointments (%d dated that day, %d other days - kept, as in the master)",
                 d, len(rows), own, len(rows) - own)
        if not rows:
            log.warning("%s: the report has no appointments - nothing to add", d)
        else:
            out = vb.OUTPUT_DIR / f"VetBuddy_AppointmentStatus_{d}.xlsx"
            write_day_xlsx(rows, out)
            log.info("Saved %s", out.name)
            if vb.SP_ENABLED:
                if not vb.retry("Archive upload", lambda o=out: archive(o), 3, 30):
                    log.error("Archive upload FAILED for %s", out.name)
                    status = 1
            days.append((d, rows))
        d += dt.timedelta(days=1)

    if a.file_only or not days:
        return status
    if not vb.SP_ENABLED:
        log.warning("SharePoint settings missing - master NOT updated (files kept locally)")
        return status

    # 3. master
    try:
        res = update_master(days, a.if_present, vb.OUTPUT_DIR / "_appt_master_work")
    except AlreadyPresent:
        log.info("The master already has %s, so it was left unchanged (use if_present = replace "
                 "to rewrite the latest day)", ", ".join(str(x) for x, _ in days))
        return status
    except Exception as e:  # noqa: BLE001
        log.error("Master update FAILED: %s", e)
        return 1
    for x in res["skipped"]:
        log.info("%s was already in the master - skipped", x)
    for x, n in res["replaced"].items():
        log.info("%s: removed its %d existing rows to replace them", x, n)
    for x, n in res["added"].items():
        log.info("%s: added %d rows", x, n)
    log.info("Master updated in SharePoint: %s (now %d rows incl. header)", APPT_MASTER_PATH, res["last_row"])
    return status


if __name__ == "__main__":
    sys.exit(main())
