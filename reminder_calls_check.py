#!/usr/bin/env python3
"""
VetBuddy reminders -> were the reminder calls made?  (Sanchu Animal Hospital)

Every morning (GitHub Actions, 7:47 AM IST - after the Corefactor and Runo call-log jobs):
  1. Logs in to VetBuddy and exports  Compliance -> Reminders Management  for reminders DUE from
     yesterday to tomorrow, all clinics (the "Healthy pet reminder" export: client, patient ID, pet,
     clinic and Treatment 1..12 = "MM-DD-YY - item [Provider->..] [Createdby->..] [Performeddate->..]").
  2. Saves the export as Excel in SharePoint:  <Sales Reports Sanchu>/Reminder management dump
  3. Finds the client's phone number (Supabase sales data, by patient ID; or the client name when
     VetBuddy has the phone number there).
  4. Checks the call logs - Corefactor (daily files in "Call Log Archive") and Runo (Runo CallLog.xlsx):
     a reminder counts as CALLED when that phone number had any call (in or out) from 3 days before
     the due date up to the due date.
  5. Updates the master  "Sanchu Reports/Reminder Management.xlsx"  (sheet "Reminders"): the rows of
     the checked due dates are replaced, older due dates stay as they are (history).
  6. Rewrites  "Sanchu Reports/Reminder Calls Pending.xlsx": who still has to be called -
     NOT CALLED (due yesterday, no call), TO CALL (due today / tomorrow, no call yet),
     NO PHONE NUMBER - with client name, phone number and the purpose of the call.

This job only READS the call logs and VetBuddy; it does not change any other job's files.

Usage:
  python reminder_calls_check.py                         due yesterday .. tomorrow
  python reminder_calls_check.py --from 2026-11-05 --to 2026-11-12    any due-date range (re-check / backfill)
Environment (GitHub secrets / variables):
  VETBUDDY_USER, VETBUDDY_PASS, SUPABASE_DB_URL, SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET
  SP_SITE_URL, SP_LIBRARY                 Sales Reports Sanchu (dump folder + Call Log Archive)
  SP_CALLLOG_ARCHIVE_FOLDER               default "Call Log Archive"
  SP_RUNO_SITE_URL, SP_RUNO_LIBRARY, SP_RUNO_MASTER_PATH     Runo CallLog.xlsx
  SP_REMINDER_SITE_URL, SP_REMINDER_LIBRARY                  where the master + pending files go
                                                             (default: the sanchureports OneDrive)
  SP_REMINDER_DUMP_FOLDER     default "Reminder management dump"
  SP_REMINDER_MASTER_PATH     default "Sanchu Reports/Reminder Management.xlsx"
  SP_REMINDER_PENDING_PATH    default "Sanchu Reports/Reminder Calls Pending.xlsx"
  REMINDER_CALL_DAYS_BEFORE   default 3 (call window: due date - N days .. due date)
"""

import argparse
import csv
import datetime as dt
import html
import io
import logging
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import vetbuddy_sales_export as vb          # noqa: E402  VetBuddy login settings, retry(), IST, logging
import corefactor_calllogs_export as cf     # noqa: E402  SharePoint helper, date parsing
import vetbuddy_sql                         # noqa: E402  Supabase connection

log = logging.getLogger("vetbuddy")
IST = vb.IST
ONEDRIVE = "https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in"


def env(name, default=""):
    return (os.environ.get(name) or "").strip() or default


DAYS_BEFORE = int(env("REMINDER_CALL_DAYS_BEFORE", "3"))
DUMP_FOLDER = env("SP_REMINDER_DUMP_FOLDER", "Reminder management dump")
MASTER_PATH = env("SP_REMINDER_MASTER_PATH", "Sanchu Reports/Reminder Management.xlsx")
PENDING_PATH = env("SP_REMINDER_PENDING_PATH", "Sanchu Reports/Reminder Calls Pending.xlsx")
ARCHIVE_FOLDER = env("SP_CALLLOG_ARCHIVE_FOLDER", "Call Log Archive")
OUTPUT_DIR = Path(env("OUTPUT_DIR", str(HERE / "reports")))

NOT_CALLED, TO_CALL, NO_PHONE, CALLED = "NOT CALLED", "TO CALL", "NO PHONE NUMBER", "CALLED"


# ----------------------------------------------------------------------------- 1. VetBuddy export
def vetbuddy_session():
    """Main VetBuddy login (the reminder pages are outside the /sanchu/ report section)."""
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (VetBuddy reminder check)"
    creds = {"userid": vb.USER, "passwd": vb.PASSWORD, "login": "login"}
    s.get(f"{vb.BASE}/vet_index.html", timeout=60)
    s.get(f"{vb.BASE}/vet_inc_session.html", params={"calledfromlogin": "true", "viewport": "1280|800"}, timeout=60)
    s.post(f"{vb.BASE}/comm_whiteboard.html", files={k: (None, v) for k, v in creds.items()}, timeout=120)
    return s


def hidden_fields(page: str) -> dict:
    """The hidden inputs of the reminder search form (e.g. printsqlquery), as the page sends them."""
    m = re.search(r'<form[^>]*name="searchpatient"[\s\S]*?</form>', page, re.I)
    part = m.group(0) if m else page
    out = {}
    for tag in re.findall(r"<input[^>]*>", part, re.I):
        if not re.search(r"type\s*=\s*['\"]?hidden", tag, re.I):
            continue
        n = re.search(r"name\s*=\s*['\"]([^'\"]+)", tag, re.I)
        v = re.search(r"value\s*=\s*['\"]([^'\"]*)", tag, re.I)
        if n and n.group(1) not in out:
            out[n.group(1)] = html.unescape(v.group(1)) if v else ""
    return out


def export_reminders(d_from: dt.date, d_to: dt.date) -> str:
    """Reminders Management -> 'Healthy pet reminder' export for reminders due d_from..d_to, all clinics."""
    s = vetbuddy_session()
    q = {"chkAllPatients": "true", "txtreminderfrom": f"{d_from:%m/%d/%Y}", "txtreminderto": f"{d_to:%m/%d/%Y}"}
    page = s.get(f"{vb.BASE}/reminder_querymanager.html", params=q, timeout=180).text
    if 'name="txtreminderfrom"' not in page:
        (HERE / "login_debug.html").write_text(page[:30000], encoding="utf-8", errors="replace")
        raise RuntimeError("Login failed - could not open Reminders Management (check VETBUDDY_USER / VETBUDDY_PASS)")
    form = hidden_fields(page)
    form.update({"calledfromquermanager": "true", "chkAllPatients": "true", "rdmode": "duedate",
                 "txtreminderfrom": f"{d_from:%m/%d/%Y}", "txtreminderto": f"{d_to:%m/%d/%Y}",
                 "txtcity": "", "selprovider": "", "selremitems": "", "selclinic": "All",
                 "hiddecision": "no", "hidsmsdecision": "no", "hidsmsnumbertype": "", "selectedreminders": "True"})
    r = s.post(f"{vb.BASE}/reminder_querymanager_csv.html", params={"type": "Healtypetreminder"},
               files={k: (None, v) for k, v in form.items()}, timeout=900)
    m = re.search(r"href='(remindergeneratedfile\.[a-z]+\?[^']+)'", r.text)
    if not m:
        (HERE / "login_debug.html").write_text(r.text[-30000:], encoding="utf-8", errors="replace")
        raise RuntimeError("VetBuddy did not return the reminder file link (layout changed?)")
    f = s.get(f"{vb.BASE}/{html.unescape(m.group(1))}", timeout=600)
    f.raise_for_status()
    text = f.content.decode("utf-8-sig", errors="replace")
    if '"Patient ID"' not in text[:2000]:
        raise RuntimeError("The reminder file is not in the expected format (no 'Patient ID' column)")
    return text


# ----------------------------------------------------------------------------- 2. parse
TREAT_RE = re.compile(r"(\d{1,2}-\d{1,2}-\d{2,4})\s*-?\s*(.*?)\s*\[Provider->(.*?)\]\s*\[Createdby->(.*?)\]"
                      r"\s*\[Performeddate->(.*?)\]")
HEAD_RE = re.compile(r'^((?:"[^"]*",){13})(.*)$')


def us_date(text):
    """'11-10-26' / '11-10-2026' (month-day-year) -> date."""
    m = re.fullmatch(r"(\d{1,2})-(\d{1,2})-(\d{2,4})", (text or "").strip())
    if not m:
        return None
    y = int(m.group(3))
    y = y + 2000 if y < 100 else y
    try:
        return dt.date(y, int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None


def clean(text):
    return re.sub(r"\s+", " ", html.unescape(text or "").replace("\xa0", " ")).strip()


def parse_reminders(text):
    """-> (header, raw rows for the dump, one dict per reminder line (treatment))."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    header = next(csv.reader([lines[0]]))
    raw_rows, items = [], []
    for ln in lines[1:]:
        m = HEAD_RE.match(ln)
        if not m:
            log.warning("Skipped an unreadable reminder line: %s", ln[:120])
            continue
        f = next(csv.reader([m.group(1)[:-1]]))
        rest = html.unescape(m.group(2))
        treats = TREAT_RE.findall(rest)
        raw_rows.append(f + [clean(" ".join(t[:2])) + f" [Provider->{clean(t[2])}] [Createdby->{clean(t[3])}]"
                             f" [Performeddate->{clean(t[4])}]" for t in treats])
        for due, item, provider, created, performed in treats:
            items.append({
                "first": clean(f[0]), "last": clean(f[1]), "city": clean(f[4]), "patient_id": clean(f[7]),
                "pet": clean(f[8]), "birthday": us_date(f[9]), "species": clean(f[10]), "breed": clean(f[11]),
                "clinic": clean(f[12]), "due": us_date(due), "purpose": clean(item).strip(" -"),
                "provider": clean(provider), "created_by": clean(created), "performed": us_date(clean(performed)),
            })
    log.info("Reminder export: %d patients, %d reminder lines", len(raw_rows), len(items))
    return header, raw_rows, items


def short_clinic(c):
    c = re.sub(r"^Sanchu Animal Hospital\s*[-,]\s*", "", c or "", flags=re.I)
    return re.sub(r"\s*\(Division[^)]*\)", "", c).strip()


def norm_phone(v):
    if isinstance(v, float) and v == int(v):
        v = int(v)
    s = str(v or "").strip()
    if re.fullmatch(r"\d+(\.\d+)?[eE]\+?\d+", s):          # Excel scientific notation, e.g. 9.87654321E9
        s = str(int(float(s)))
    if re.fullmatch(r"\d+\.0", s):
        s = s[:-2]
    d = re.sub(r"\D", "", s)
    return d[-10:] if len(d) >= 10 else ""


# ----------------------------------------------------------------------------- 3. phone numbers
def phones_for(pet_ids):
    """Latest client name + phone per patient ID from the sales data (Supabase)."""
    out = {}
    if not pet_ids or not vetbuddy_sql.ENABLED:
        return out
    with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ON (pet) pet, client_name, client_phone FROM (
              SELECT substring(client_id from '\\(([^)]*)\\)') AS pet, client_name, client_phone, sale_date
              FROM vetbuddy.sales WHERE client_id IS NOT NULL) x
            WHERE pet = ANY(%s) ORDER BY pet, sale_date DESC""", (list(pet_ids),))
        for pet, name, phone in cur.fetchall():
            out[str(pet)] = (name or "", norm_phone(phone))
    return out


# ----------------------------------------------------------------------------- 4. call logs
class Call:
    __slots__ = ("when", "source", "kind", "result", "agent")

    def __init__(self, when, source, kind, result, agent):
        self.when, self.source, self.kind, self.result, self.agent = when, source, kind, result, agent

    @property
    def day(self):
        return self.when.date() if isinstance(self.when, dt.datetime) else self.when

    @property
    def answered(self):
        r = (self.result or "").lower()
        return ("answer" in r and "unanswer" not in r and "not answer" not in r) or r in ("connected", "completed")


def read_table(name, data):
    """Rows (dicts by header) of a .csv / .xlsx / .xls file."""
    ext = Path(name).suffix.lower()
    if ext in (".csv", ".txt"):
        return list(csv.DictReader(io.StringIO(data.decode("utf-8-sig", errors="replace"))))
    if ext in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        it = wb.worksheets[0].iter_rows(values_only=True)
        hdr = [str(h or "").strip() for h in next(it)]
        return [dict(zip(hdr, r)) for r in it]
    import xlrd
    sh = xlrd.open_workbook(file_contents=data).sheet_by_index(0)
    hdr = [str(h).strip() for h in sh.row_values(0)]
    return [dict(zip(hdr, sh.row_values(i))) for i in range(1, sh.nrows)]


def pick(row, *names):
    keys = {cf.norm(k): k for k in row}
    for n in names:
        k = keys.get(cf.norm(n))
        if k is not None and row[k] not in (None, ""):
            return row[k]
    return None


def corefactor_calls(sp_sales, first: dt.date, last: dt.date, calls, missing):
    d = first
    while d <= last:
        got = False
        for ext in (".csv", ".xlsx", ".xls"):
            name = f"Corefactor_CallLogs_{d.isoformat()}{ext}"
            try:
                data, _ = sp_sales.download(f"{ARCHIVE_FOLDER.strip('/')}/{name}")
            except Exception:  # noqa: BLE001  (not there with this extension)
                continue
            n = 0
            for r in read_table(name, data):
                ph = norm_phone(pick(r, "Customer Number"))
                when = cf.parse_dt(pick(r, "Call Date", "Start Time")) or cf.as_date(pick(r, "Call Date"))
                if ph and when:
                    calls[ph].append(Call(when, "Corefactor", pick(r, "Call Type") or "", pick(r, "Call Status") or "",
                                          pick(r, "Agent Name") or ""))
                    n += 1
            log.info("Corefactor %s: %d calls", d, n)
            got = True
            break
        if not got:
            missing.append(f"Corefactor {d}")
            log.warning("No Corefactor call-log file for %s in '%s'", d, ARCHIVE_FOLDER)
        d += dt.timedelta(days=1)


def runo_calls(first: dt.date, last: dt.date, calls, missing):
    path = env("SP_RUNO_MASTER_PATH", "Sanchu Reports/Runo CallLog.xlsx")
    try:
        sp = cf.SharePoint.from_env("SP_RUNO_SITE_URL", "SP_RUNO_LIBRARY")
        data, _ = sp.download(path)
    except Exception as e:  # noqa: BLE001
        missing.append("Runo master")
        log.warning("Runo call log not read (%s)", e)
        return
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    it = wb.worksheets[0].iter_rows(values_only=True)
    hdr = [cf.norm(h) for h in next(it)]
    ix = {n: hdr.index(n) for n in ("phone", "callstartdate", "calltype", "calltag", "status", "callername") if n in hdr}
    if "phone" not in ix or "callstartdate" not in ix:
        missing.append("Runo master (columns)")
        log.warning("Runo call log: 'Phone' / 'Call Start Date' columns not found")
        return
    n = 0
    for r in it:
        when = r[ix["callstartdate"]]
        when = cf.parse_dt(when) if not isinstance(when, (int, float)) else (
            dt.datetime(1899, 12, 30) + dt.timedelta(days=float(when)) if 20000 < when < 80000 else None)
        if not when or not (first <= when.date() <= last):
            continue
        ph = norm_phone(r[ix["phone"]])
        if ph:
            g = lambda k: (r[ix[k]] if k in ix else "") or ""   # noqa: E731
            calls[ph].append(Call(when, "Runo", g("calltype"), g("calltag"), g("status") or g("callername")))
            n += 1
    log.info("Runo %s .. %s: %d calls", first, last, n)


# ----------------------------------------------------------------------------- 5. check
def check(items, phones, calls, calls_upto: dt.date, today: dt.date):
    out = []
    for it in items:
        if not it["due"]:
            continue
        name_phone = norm_phone(it["first"]) if re.fullmatch(r"[\d +\-]{10,}", it["first"] or "") else ""
        db_name, db_phone = phones.get(it["patient_id"], ("", ""))
        phone = name_phone or db_phone
        client = " ".join(x for x in (it["first"], it["last"]) if x and x not in ("-", ".")) if not name_phone else ""
        client = client or db_name or "(name not in VetBuddy)"
        win_from = it["due"] - dt.timedelta(days=DAYS_BEFORE)
        hits = sorted([c for c in calls.get(phone, []) if win_from <= c.day <= it["due"]], key=lambda c: c.when) if phone else []
        best = ([c for c in hits if c.answered] or hits)[-1] if hits else None
        if not phone:
            status = NO_PHONE
        elif best:
            status = CALLED
        elif it["due"] <= calls_upto:
            status = NOT_CALLED
        else:
            status = TO_CALL
        out.append({**it, "client": client, "phone": phone, "status": status,
                    "call_when": best.when if best else None, "call_source": best.source if best else "",
                    "call_type": str(best.kind) if best else "", "call_result": str(best.result) if best else "",
                    "called_by": str(best.agent) if best else "", "calls_in_window": len(hits), "checked": today})
    order = {NOT_CALLED: 0, TO_CALL: 1, NO_PHONE: 2, CALLED: 3}
    out.sort(key=lambda r: (r["due"], short_clinic(r["clinic"]), order[r["status"]], r["client"].lower()))
    return out


# ----------------------------------------------------------------------------- 6. Excel files
MASTER_COLS = ["Due Date", "Call Status", "Clinic", "Client Name", "Phone", "Patient ID", "Pet Name", "Species",
               "Breed", "Purpose of Call", "Provider", "Created By", "Last Performed", "Called On", "Call Source",
               "Call Type", "Call Result", "Called By", "Calls in Window", "Checked On"]


def master_row(r):
    return [r["due"], r["status"], short_clinic(r["clinic"]), r["client"], r["phone"], r["patient_id"], r["pet"],
            r["species"], r["breed"], r["purpose"], r["provider"], r["created_by"], r["performed"], r["call_when"],
            r["call_source"], r["call_type"], r["call_result"], r["called_by"], r["calls_in_window"], r["checked"]]


def style_sheet(ws, ncols, date_cols=(), datetime_cols=(), widths=None):
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    for c in ws[1]:
        c.font, c.fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="1F3864")
        c.alignment = Alignment(wrap_text=True, vertical="center")
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(ncols)}{max(ws.max_row, 1)}"
    for i, w in enumerate(widths or [], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for row in ws.iter_rows(min_row=2):
        for c in row:
            if c.column in date_cols:
                c.number_format = "dd-mm-yyyy"
            elif c.column in datetime_cols:
                c.number_format = "dd-mm-yyyy hh:mm"


STATUS_FILL = {NOT_CALLED: "F8CBAD", TO_CALL: "FFE699", NO_PHONE: "D9D9D9", CALLED: "C6EFCE"}
WIDTHS = [11, 15, 16, 22, 13, 10, 14, 9, 16, 42, 28, 22, 13, 16, 11, 10, 18, 22, 8, 11]


def colour_status(ws, col=2):
    from openpyxl.styles import PatternFill
    for row in ws.iter_rows(min_row=2, min_col=col, max_col=col):
        for c in row:
            if c.value in STATUS_FILL:
                c.fill = PatternFill("solid", fgColor=STATUS_FILL[c.value])


def update_master(sp, checked, d_from, d_to):
    """Replace the master rows of the checked due dates; keep all other due dates."""
    from openpyxl import Workbook, load_workbook
    for attempt in range(1, 31):
        try:
            data, etag = sp.download(MASTER_PATH)
            wb = load_workbook(io.BytesIO(data))
            ws = wb["Reminders"] if "Reminders" in wb.sheetnames else wb.worksheets[0]
            hdr = [str(c.value or "").strip() for c in ws[1]]
            if hdr[:len(MASTER_COLS)] != MASTER_COLS:
                raise RuntimeError(f"Master headers changed ({hdr[:5]}...) - master NOT changed")
            keep = [list(r) for r in ws.iter_rows(min_row=2, values_only=True)
                    if r and cf.as_date(r[0]) and not (d_from <= cf.as_date(r[0]) <= d_to)]
        except cf.RunError as e:
            if "404" not in str(e):
                raise
            wb, etag, keep = Workbook(), None, []
            ws = wb.active
            ws.title = "Reminders"
            log.info("Creating the master %s", MASTER_PATH)
        rows = keep + [master_row(r) for r in checked]
        rows.sort(key=lambda r: (cf.as_date(r[0]) or dt.date.min, str(r[2]), str(r[3])))
        ws.delete_rows(1, ws.max_row)
        ws.append(MASTER_COLS)
        for r in rows:
            ws.append(r)
        style_sheet(ws, len(MASTER_COLS), date_cols=(1, 13, 20), datetime_cols=(14,), widths=WIDTHS)
        colour_status(ws)
        buf = io.BytesIO()
        wb.save(buf)
        try:
            sp.upload(MASTER_PATH, buf.getvalue(), if_match=etag)
            log.info("Master updated: %s (%d rows, %d checked now)", MASTER_PATH, len(rows), len(checked))
            return
        except cf.FileLocked:
            log.warning("Master is open/locked - retrying in 60 s (%d/30)", attempt)
        except cf.UploadConflict:
            log.warning("Master changed while updating - redoing (%d/30)", attempt)
        time.sleep(60)
    raise RuntimeError("Master stayed locked for 30 minutes - not updated")


PENDING_COLS = ["Call Status", "Due Date", "Clinic", "Client Name", "Phone", "Pet Name", "Species", "Breed",
                "Purpose of Call", "Provider", "Last Performed", "Patient ID"]


def write_pending(sp, checked, today, calls_upto, missing):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    pend = [r for r in checked if r["status"] != CALLED]
    wb = Workbook()
    ws = wb.active
    ws.title = "To call"
    ws.append(PENDING_COLS)
    for r in pend:
        ws.append([r["status"], r["due"], short_clinic(r["clinic"]), r["client"], r["phone"], r["pet"], r["species"],
                   r["breed"], r["purpose"], r["provider"], r["performed"], r["patient_id"]])
    style_sheet(ws, len(PENDING_COLS), date_cols=(2, 11), widths=[15, 11, 16, 24, 13, 14, 9, 16, 44, 28, 13, 10])
    colour_status(ws, col=1)
    # summary per clinic and due date
    sm = wb.create_sheet("Summary")
    sm.append([f"Reminder calls - checked {today:%d-%m-%Y} (call logs up to {calls_upto:%d-%m-%Y}; a reminder counts as "
               f"called when the client's number had a call from {DAYS_BEFORE} days before the due date up to the due date)"])
    sm["A1"].font = Font(bold=True)
    if missing:
        sm.append(["Call logs missing (those calls could not be checked): " + ", ".join(missing)])
    sm.append([])
    sm.append(["Due Date", "Clinic", "Reminders", CALLED, NOT_CALLED, TO_CALL, NO_PHONE, "Called %"])
    head = sm.max_row
    g = defaultdict(lambda: defaultdict(int))
    for r in checked:
        k = (r["due"], short_clinic(r["clinic"]))
        g[k]["n"] += 1
        g[k][r["status"]] += 1
    for (due, clinic), c in sorted(g.items()):
        base = c["n"] - c[TO_CALL] - c[NO_PHONE]
        sm.append([due, clinic, c["n"], c[CALLED], c[NOT_CALLED], c[TO_CALL], c[NO_PHONE],
                   round(100 * c[CALLED] / base, 1) if base else None])
    for c in sm[head]:
        c.font = Font(bold=True)
    for row in sm.iter_rows(min_row=head + 1, max_col=1):
        for c in row:
            c.number_format = "dd-mm-yyyy"
    for col, w in zip("ABCDEFGH", [12, 18, 10, 9, 11, 9, 16, 9]):
        sm.column_dimensions[col].width = w
    buf = io.BytesIO()
    wb.save(buf)
    for attempt in range(1, 31):
        try:
            sp.upload(PENDING_PATH, buf.getvalue())
            log.info("Pending list written: %s (%d to call)", PENDING_PATH, len(pend))
            return len(pend)
        except cf.FileLocked:
            log.warning("Pending file is open/locked - retrying in 60 s (%d/30)", attempt)
            time.sleep(60)
    raise RuntimeError("Pending file stayed locked for 30 minutes - not updated")


def dump_xlsx(header, raw_rows, d_from, d_to) -> Path:
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Reminders"
    ws.append(header)
    for r in raw_rows:
        ws.append(r)
    style_sheet(ws, len(header))
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUTPUT_DIR / f"VetBuddy_Reminders_due_{d_from}_to_{d_to}.xlsx"
    wb.save(p)
    return p


# ----------------------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--from", dest="d_from", help="first due date YYYY-MM-DD (default yesterday)")
    ap.add_argument("--to", dest="d_to", help="last due date YYYY-MM-DD (default tomorrow)")
    a = ap.parse_args(argv)
    today = dt.datetime.now(IST).date()
    calls_upto = today - dt.timedelta(days=1)                     # call logs are loaded up to yesterday
    d_from = dt.date.fromisoformat(a.d_from) if a.d_from else today - dt.timedelta(days=1)
    d_to = dt.date.fromisoformat(a.d_to) if a.d_to else today + dt.timedelta(days=1)
    if d_to < d_from:
        log.error("--to is before --from")
        return 1
    if not (vb.USER and vb.PASSWORD):
        log.error("VETBUDDY_USER / VETBUDDY_PASS missing")
        return 1
    log.info("Reminder check: due %s .. %s (call logs up to %s, window %d days before due)", d_from, d_to,
             calls_upto, DAYS_BEFORE)

    got = {}
    if not vb.retry("Reminder export", lambda: got.update(text=export_reminders(d_from, d_to)), 3, 60):
        log.error("Reminder export FAILED - nothing changed")
        return 1
    header, raw_rows, items = parse_reminders(got["text"])
    items = [i for i in items if i["due"] and d_from <= i["due"] <= d_to]
    status = 0

    sp_sales = cf.SharePoint.from_env("SP_SITE_URL", "SP_LIBRARY")
    dump = dump_xlsx(header, raw_rows, d_from, d_to)
    try:
        sp_sales.ensure_folder(DUMP_FOLDER)
        sp_sales.upload(f"{DUMP_FOLDER.strip('/')}/{dump.name}", dump.read_bytes())
        log.info("Dump saved: %s/%s", DUMP_FOLDER, dump.name)
    except Exception as e:  # noqa: BLE001
        log.error("Dump upload FAILED: %s", e)
        status = 1

    phones = phones_for({i["patient_id"] for i in items})
    log.info("Phone numbers found for %d of %d patients", sum(1 for p in phones.values() if p[1]),
             len({i["patient_id"] for i in items}))
    calls, missing = defaultdict(list), []
    first_call_day = d_from - dt.timedelta(days=DAYS_BEFORE)
    last_call_day = min(d_to, calls_upto)
    if first_call_day <= last_call_day:
        corefactor_calls(sp_sales, first_call_day, last_call_day, calls, missing)
        runo_calls(first_call_day, last_call_day, calls, missing)
    checked = check(items, phones, calls, calls_upto, today)
    counts = defaultdict(int)
    for r in checked:
        counts[r["status"]] += 1
    log.info("Result: %s", ", ".join(f"{k} {v}" for k, v in counts.items()) or "no reminders")

    sp_out = cf.SharePoint.from_env("SP_REMINDER_SITE_URL", "SP_REMINDER_LIBRARY") if env("SP_REMINDER_SITE_URL") else \
        cf.SharePoint(env("SP_TENANT_ID"), env("SP_CLIENT_ID"), env("SP_CLIENT_SECRET"), ONEDRIVE,
                      env("SP_REMINDER_LIBRARY", "Documents"))
    for what, fn in (("Master update", lambda: update_master(sp_out, checked, d_from, d_to)),
                     ("Pending list", lambda: write_pending(sp_out, checked, today, calls_upto, missing))):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            log.error("%s FAILED: %s", what, e)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
