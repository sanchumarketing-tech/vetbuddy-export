#!/usr/bin/env python3
"""
VetBuddy deceased pets -> "Deceased Pets Data.xlsx" (sanchureports OneDrive), month to date (23 Nov 2026).

VetBuddy path (same as by hand): Compliance -> Even more -> Patient Search by Visit Date Range ->
Deceased -> Search All Clinics -> Search -> Export Mail Merge File -> Download XLS File.

VetBuddy's date filter on that page is the pet's FIRST activation date, so the robot searches all dates
(1 Jan 2015 -> yesterday) and keeps the pets whose "Last Active" date is in the month: 1st of this month ->
yesterday (on the 1st: the whole previous month). Those rows replace the month's rows in the workbook
(sheet "Deceased Data"), matched to the workbook's columns by header name. A day file is kept in
"Sanchu Reports/Deceased Archive".

Usage:
  python vetbuddy_deceased_export.py            daily run (month to date)
  python vetbuddy_deceased_export.py --check    only report the workbook's layout and the export's counts
  python vetbuddy_deceased_export.py --month 2026-10   rewrite one whole month

Call Desk (23 Nov 2026): every run also replaces calldesk.deceased_pets with ALL deceased pets (any date)
and calls calldesk.deceased_apply(), so no call is made about a deceased pet (needs SUPABASE_DB_URL).
"""
import argparse
import datetime as dt
import io
import logging
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

import openpyxl
import requests
import xlrd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vetbuddy_sales_export as vb   # noqa: E402  login settings, SharePoint helpers

log = logging.getLogger("deceased")
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
BASE = vb.BASE
SITE = os.environ.get("SP_DECEASED_SITE_URL") or "https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in"
LIBRARY = os.environ.get("SP_DECEASED_LIBRARY") or "Documents"
MASTER_NAME = os.environ.get("SP_DECEASED_NAME") or "Deceased Pets Data.xlsx"
MASTER_PATH = os.environ.get("SP_DECEASED_PATH", "")          # found by name when empty
# 23 Nov 2026: the team's workbook, pinned by its id (a search can miss it or find a copy). Written by id too.
MASTER_ID = os.environ.get("SP_DECEASED_ITEM_ID") or "01DIVYIDHTXAGQL34EVZGKQYRBPS7D7ANV"
SHEET = os.environ.get("SP_DECEASED_SHEET") or "Deceased Data"
ARCHIVE = os.environ.get("SP_DECEASED_ARCHIVE") or "Sanchu Reports/Deceased Archive"
SEARCH_FROM = dt.date(2015, 1, 1)
MON = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def norm(h):
    return re.sub(r"[^a-z0-9]", "", str(h or "").lower())


def vb_date(v):
    """VetBuddy writes '07, Nov 26'. Also accepts real dates and Excel serials."""
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (int, float)) and v > 20000:
        return (dt.datetime(1899, 12, 30) + dt.timedelta(days=float(v))).date()
    m = re.match(r"\s*(\d{1,2})\s*,?\s*([A-Za-z]{3})[a-z]*\s*,?\s*(\d{2,4})", str(v or ""))
    if m and m.group(2).lower() in MON:
        y = int(m.group(3))
        return dt.date(y + 2000 if y < 100 else y, MON[m.group(2).lower()], int(m.group(1)))
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(str(v).strip()[:10], fmt).date()
        except ValueError:
            pass
    return None


# ---------------------------------------------------------------- VetBuddy
def login(s):
    """Main VetBuddy login (the patient search lives in the main app, not the /sanchu report section)."""
    creds = {"userid": vb.USER, "passwd": vb.PASSWORD, "login": "login"}
    s.get(f"{BASE}/vet_index.html", timeout=60)
    s.get(f"{BASE}/vet_inc_session.html", params={"calledfromlogin": "true", "viewport": "1280|800"}, timeout=60)
    s.post(f"{BASE}/comm_whiteboard.html", files={k: (None, v) for k, v in creds.items()}, timeout=120)
    r = s.get(f"{BASE}/patient_querymanager.html", params={"menuitem": "4"}, timeout=120)
    if 'name="searchpatient"' not in r.text:
        raise RuntimeError("VetBuddy login failed (patient search page not available) - check VETBUDDY_USER / VETBUDDY_PASS")
    log.info("Logged in to VetBuddy as %s", vb.USER)


def form(d_to):
    return {"clientid": "1", "patientid": "", "problemid": "", "menuitem": "4", "callforencounter": "",
            "txtfirstActivebefore": SEARCH_FROM.strftime("%m/%d/%Y"), "txtfirstactiveafter": d_to.strftime("%m/%d/%Y"),
            "rdstatus": "3",                      # Deceased
            "selclinic": "All", "selprovider": "", "selectClient": "", "hidPatient": "true", "hidQuery": ""}


def download(s, d_to):
    """Search (deceased, all clinics), export the mail merge file, download the XLS. Returns the .xls bytes."""
    f = form(d_to)
    r = s.post(f"{BASE}/patient_querymanager.html?cmdsubmit=true&clientid=1&patientid=&problemid=", data=f, timeout=600)
    q = re.search(r"exportcsv\('([^']*)'", r.text)
    n = re.search(r"Search Result\s*\((\d+)\)", r.text)
    if not q:
        raise RuntimeError("VetBuddy search gave no 'Export Mail Merge File' (session expired or page changed)")
    log.info("VetBuddy search: deceased pets, all clinics, first activation %s -> %s: %s found",
             SEARCH_FROM, d_to, n.group(1) if n else "?")
    f["hidQuery"] = q.group(1)                    # the filter exactly as VetBuddy's own page builds it
    r = s.post(f"{BASE}/patient_querymanager_csv.html?type=csv", data=f, timeout=600)
    m = re.search(r"(pateintgeneratedfile\.xls\?[^\"'<>\s]+)", r.text)
    if not m:
        raise RuntimeError("Export page gave no 'Download XLS File' link")
    x = s.get(f"{BASE}/{m.group(1).replace('&amp;', '&')}", timeout=600)
    x.raise_for_status()
    if not x.content.startswith(vb.XLS_MAGIC):
        raise RuntimeError("Downloaded file is not an Excel file")
    return x.content


def parse(xls):
    sh = xlrd.open_workbook(file_contents=xls).sheet_by_index(0)
    hdr = [str(sh.cell_value(0, c)).strip() for c in range(sh.ncols)]
    rows = [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(1, sh.nrows)]
    rows = [r for r in rows if any(str(v).strip() for v in r)]
    return hdr, rows


# ---------------------------------------------------------------- SharePoint workbook
def find_master(h, drive):
    if MASTER_ID:
        r = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/items/{MASTER_ID}", headers=h, timeout=60)
        vb._check(r, f"Finding the workbook (item {MASTER_ID})")
        it = r.json()
        log.info("Workbook: %s/%s (item %s, last changed %s by %s)", (it.get("parentReference") or {}).get("path", "").split("root:")[-1],
                 it["name"], MASTER_ID, it.get("lastModifiedDateTime"), ((it.get("lastModifiedBy") or {}).get("user") or {}).get("displayName"))
        return it
    if MASTER_PATH:
        r = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/root:/{quote(MASTER_PATH.strip('/'))}", headers=h, timeout=60)
        vb._check(r, f"Finding '{MASTER_PATH}'")
        return r.json()
    r = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/root/search(q='{quote(MASTER_NAME)}')", headers=h, timeout=60)
    vb._check(r, f"Searching for '{MASTER_NAME}'")
    hits = [i for i in r.json().get("value", []) if i.get("file") and i["name"].lower() == MASTER_NAME.lower()]
    if len(hits) != 1:
        raise RuntimeError(f"'{MASTER_NAME}' found {len(hits)} times - set SP_DECEASED_PATH")
    it = hits[0]
    log.info("Workbook: %s/%s", it["parentReference"].get("path", "").split("root:")[-1], it["name"])
    return it


def put_by_id(h, drive_id, item_id, local, if_match=""):
    """Replace the content of THIS file (by id, never by path - a path can make a second copy)."""
    hh = dict(h)
    if if_match:
        hh["If-Match"] = if_match
    r = requests.post(f"{vb.GRAPH}/drives/{drive_id}/items/{item_id}/createUploadSession", headers=hh,
                      json={"item": {"@microsoft.graph.conflictBehavior": "replace"}}, timeout=60)
    vb._check(r, "Starting the workbook upload")
    url = r.json()["uploadUrl"]
    data = Path(local).read_bytes()
    r = requests.put(url, data=data, timeout=300, headers={"Content-Length": str(len(data)),
                                                           "Content-Range": f"bytes 0-{len(data) - 1}/{len(data)}"})
    if r.status_code not in (200, 201):
        requests.delete(url, timeout=60)
        raise RuntimeError(f"Workbook upload failed ({r.status_code}): {r.text[:300]}")
    j = r.json()
    if j.get("id") != item_id:
        raise RuntimeError(f"Upload went to another file ({j.get('id')}) - check the workbook")
    log.info("Workbook saved (item %s, %s bytes)", j.get("id"), j.get("size"))
    return j


def header_row(ws):
    for r in range(1, 11):
        if sum(1 for c in ws[r] if c.value not in (None, "")) >= 3:
            return r
    raise RuntimeError(f"No header row found in sheet '{ws.title}'")


def last_row(ws, first):
    r = ws.max_row
    while r >= first and all(c.value in (None, "") for c in ws[r]):
        r -= 1
    return r


def update(wb, hdr, rows, d_from, d_to, check=False):
    if SHEET not in wb.sheetnames:
        raise RuntimeError(f"Sheet '{SHEET}' not in the workbook (sheets: {wb.sheetnames})")
    ws = wb[SHEET]
    hr = header_row(ws)
    mh = {ci: c.value for ci, c in enumerate(ws[hr], 1) if c.value not in (None, "")}
    last = last_row(ws, hr + 1)
    by = {norm(v): ci for ci, v in mh.items()}
    src = {norm(h): i for i, h in enumerate(hdr)}
    missing = [h for h in hdr if norm(h) not in by]
    extra = [v for ci, v in mh.items() if norm(v) not in src]
    la_col = by.get("lastactive") or next((ci for k, ci in by.items() if "lastactiv" in k), None)
    log.info("Sheet '%s': header row %d, %d columns, last row %d", SHEET, hr, len(mh), last)
    log.info("Workbook columns: %s", " | ".join(f"{ci}:{v}" for ci, v in mh.items()))
    log.info("Export columns:   %s", " | ".join(hdr))
    if missing:
        log.warning("Export columns not in the workbook: %s", missing)
    if extra:
        log.info("Workbook columns not in the export (kept; formulas dragged down): %s", extra)
    if la_col is None:
        raise RuntimeError("The workbook has no 'Last Active' column - cannot tell which rows belong to the month")
    # how the workbook stores dates
    sample = {ci: ws.cell(last, ci) for ci in mh}
    old = [r for r in range(hr + 1, last + 1) if (lambda d: d and d_from <= d <= d_to)(vb_date(ws.cell(r, la_col).value))]
    dates = [vb_date(ws.cell(r, la_col).value) for r in range(hr + 1, last + 1)]
    dates = [d for d in dates if d]
    log.info("Workbook 'Last Active': %s .. %s; %d rows already in %s..%s; new month-to-date rows: %d",
             min(dates) if dates else "-", max(dates) if dates else "-", len(old), d_from, d_to, len(rows))
    if check:
        for ci, v in mh.items():
            cells = [ws.cell(r, ci) for r in range(hr + 1, last + 1)]
            filled = [c for c in cells if c.value not in (None, "")]
            kinds = sorted({("formula" if isinstance(c.value, str) and c.value.startswith("=") else type(c.value).__name__) for c in filled})
            log.info("  column %2d %-16s filled %3d of %d  %s  fmt=%s%s", ci, v, len(filled), len(cells), kinds,
                     cells[-1].number_format if cells else "",
                     ("  e.g. " + str(filled[-1].value)[:40]) if filled and norm(v) in ("birthdate", "deceaseddate", "firstactive", "lastactive") else "")
        return {"removed": 0, "added": 0}
    if missing:
        raise RuntimeError(f"Header check failed - the workbook has no column for {missing}. Nothing was changed.")
    # formulas of the extra columns (from the last row), to drag down
    formula = {ci: c.value for ci, c in sample.items() if isinstance(c.value, str) and c.value.startswith("=") and norm(mh[ci]) not in src}
    fmts = {ci: c.number_format for ci, c in sample.items()}
    styles = {ci: c._style for ci, c in sample.items()}
    # remove the month's old rows (bottom first), then append the new ones
    for r in sorted(old, reverse=True):
        ws.delete_rows(r)
    start = last_row(ws, hr + 1) + 1
    for k, row in enumerate(rows):
        r = start + k
        for ci, name in mh.items():
            c = ws.cell(r, ci)
            if ci in formula:
                c.value = re.sub(r"([A-Z]{1,3})%d\b" % last, lambda m: f"{m.group(1)}{r}", formula[ci])
            elif norm(name) in src:
                v = row[src[norm(name)]]
                if isinstance(sample[ci].value, (dt.date, dt.datetime)) and vb_date(v):
                    v = vb_date(v)
                elif isinstance(v, float) and v.is_integer():
                    v = int(v)
                c.value = v if v != "" else None
            c._style = styles[ci]
            c.number_format = fmts[ci]
    end = start + len(rows) - 1
    for t in ws.tables.values():                        # an Excel table grows with the data
        a, b = t.ref.split(":")
        t.ref = f"{a}:{re.sub(r'[0-9]+$', '', b)}{max(end, hr + 1)}"
    log.info("Removed %d old rows of the month, added %d rows (rows %d-%d)", len(old), len(rows), start, end)
    return {"removed": len(old), "added": len(rows)}


def load_calldesk(hdr, allrows):
    """All deceased pets -> calldesk.deceased_pets (full replace), then calldesk.deceased_apply()."""
    if not os.environ.get("SUPABASE_DB_URL"):
        log.warning("SUPABASE_DB_URL missing - Call Desk deceased list not updated")
        return
    import vetbuddy_sql
    col = {norm(h): i for i, h in enumerate(hdr)}
    need = ("patientid", "patient", "clientname", "firstactive", "lastactive")
    if any(k not in col for k in need):
        raise RuntimeError(f"Export columns changed - Call Desk list not updated: {hdr}")

    def cell(r, k):
        v = r[col[k]]
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        return str(v).strip() if v not in (None, "") else None

    pets = {}
    for r in allrows:
        pid = cell(r, "patientid")
        if pid:
            pets[pid] = (pid, cell(r, "patient"), cell(r, "clientname"), cell(r, "firstactive"), vb_date(r[col["lastactive"]]))
    with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
        cur.execute("select count(*) from calldesk.deceased_pets where source = 'vetbuddy'")
        old = cur.fetchone()[0]
        if len(pets) < 0.9 * old:          # a short download must never re-open calls
            raise RuntimeError(f"Only {len(pets)} deceased pets in the export (the list has {old}) - Call Desk list not changed")
        cur.execute("delete from calldesk.deceased_pets")
        with cur.copy("COPY calldesk.deceased_pets (pet_id, pet_name, client_name, first_active, last_active) FROM STDIN") as cp:
            for row in pets.values():
                cp.write_row(row)
        conn.commit()                      # the list is kept even if the clean-up below fails
        cur.execute("select calldesk.deceased_apply()")
        res = cur.fetchone()[0]
        conn.commit()
    log.info("Call Desk: %d deceased pets loaded (was %d) - %s", len(pets), old, res)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true")
    p.add_argument("--month", help="YYYY-MM: rewrite one whole month")
    a = p.parse_args(argv)
    today = dt.datetime.now(IST).date()
    if a.month:
        y, m = (int(x) for x in a.month.split("-"))
        d_from = dt.date(y, m, 1)
        d_to = min((d_from.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), today - dt.timedelta(days=1))
    else:
        d_from, d_to = vb.mtd_range(today)
    if not vb.USER or not vb.PASSWORD:
        log.error("VETBUDDY_USER / VETBUDDY_PASS missing")
        return 1

    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (VetBuddy deceased export)"
    for attempt in (1, 2):
        try:
            login(s)
            hdr, allrows = parse(download(s, d_to))
            break
        except Exception as e:                           # noqa: BLE001
            if attempt == 2:
                raise
            log.warning("VetBuddy: %s - trying once more in 60s", e)
            time.sleep(60)
            s = requests.Session()
    ci = next((i for i, h in enumerate(hdr) if norm(h) == "lastactive"), None)
    if ci is None:
        raise RuntimeError(f"Export has no 'Last Active' column: {hdr}")
    rows = [r for r in allrows if (lambda d: d and d_from <= d <= d_to)(vb_date(r[ci]))]
    rows.sort(key=lambda r: (vb_date(r[ci]), str(r[0])))
    log.info("Export: %d deceased pets in all, %d with Last Active %s..%s", len(allrows), len(rows), d_from, d_to)
    cd_error = None
    if not a.check:
        try:
            load_calldesk(hdr, allrows)    # first: the Call Desk block matters more than the workbook
        except Exception as e:             # noqa: BLE001  the workbook is still updated; the run ends as failed
            cd_error = e
            log.error("Call Desk deceased list NOT updated: %s", e)

    h = {"Authorization": f"Bearer {vb.graph_token()}"}
    drive = vb.sp_drive(h, SITE, LIBRARY)
    item = find_master(h, drive)
    data = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/items/{item['id']}/content", headers=h, timeout=300)
    vb._check(data, "Downloading the workbook")
    wb = openpyxl.load_workbook(io.BytesIO(data.content))
    res = update(wb, hdr, rows, d_from, d_to, check=a.check)
    if a.check:
        log.info("Check only - nothing changed")
        return 0

    work = vb.OUTPUT_DIR / "_deceased"
    work.mkdir(parents=True, exist_ok=True)
    # day file for the archive (the month's rows as exported)
    day = openpyxl.Workbook()
    dws = day.active
    dws.title = "Deceased"
    dws.append(hdr)
    for r in rows:
        dws.append([int(v) if isinstance(v, float) and v.is_integer() else v for v in r])
    dfile = work / f"VetBuddy_Deceased_MTD_{d_from}_to_{d_to}.xlsx"
    day.save(dfile)
    vb.sp_ensure_folder(h, drive["id"], ARCHIVE)
    vb.sp_put_file(h, drive["id"], dfile, f"{ARCHIVE}/{dfile.name}")
    out = work / "master_out.xlsx"
    wb.save(out)
    put_by_id(h, drive["id"], item["id"], out, if_match=item.get("eTag", ""))
    log.info("Done: %s updated - %d rows for %s..%s (%d old rows replaced)", item["name"], res["added"], d_from, d_to, res["removed"])
    return 1 if cd_error else 0


if __name__ == "__main__":
    sys.exit(main())
