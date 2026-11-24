"""
Gofrugal pharmacy sales (Gofrugal Prime HQ, e.g. https://sanchuhq.gofrugal.com).

Downloads the same reports the team exports by hand, for any date range:
  3111  Sales Detail - Itemwise          (sales: "Item Amt BeforeTax")
  3126  Sales Return Detail - Itemwise   (returns: "Sub Total", deducted)
All shops. Then each line is given the Vet on Wheels split (vow.py):
  a pharmacy bill is VOW when the same doctor billed a VOW invoice in VetBuddy on
  the same date at the same clinic.

Settings (environment / GitHub secrets):
  GOFRUGAL_USER, GOFRUGAL_PASS     the HQ login (e.g. CITPL)
  GOFRUGAL_URL                     optional, default https://sanchuhq.gofrugal.com
"""

import csv
import datetime as dt
import io
import logging
import os
import re

import requests

import vow

log = logging.getLogger("vetbuddy")

BASE = os.environ.get("GOFRUGAL_URL", "") or "https://sanchuhq.gofrugal.com"
USER = os.environ.get("GOFRUGAL_USER", "")
PASSWORD = os.environ.get("GOFRUGAL_PASS", "")
ENABLED = bool(USER and PASSWORD)

SALES_REPORT = (3111, "Sales Detail - Itemwise")
RETURNS_REPORT = (3126, "Sales Return Detail - Itemwise")
PRODUCT_ID = 4


# ---------------------------------------------------------------- web
class Session:
    def __init__(self):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "Mozilla/5.0 (VetBuddy automation)"
        self.role_id = None
        self.login_id = None

    def login(self, user=None, password=None):
        user, password = user or USER, password or PASSWORD
        self.s.get(f"{BASE}/RayMedi_HQ/mainIndex.do", timeout=60)          # login page + session
        self.s.post(f"{BASE}/RayMedi_HQ/j_security_check",
                    data={"j_username": user, "j_password": password}, timeout=120)
        self.s.get(f"{BASE}/smartreport/index.html", timeout=60)             # report module session
        r = self.s.get(f"{BASE}/smartreport/user",
                       params={"referrerProduct": "", "companyCode": "", "isHQ": "false"}, timeout=60)
        try:
            u = r.json()
        except ValueError:
            u = {}
        if r.status_code != 200 or not u.get("roleId"):
            raise RuntimeError("Gofrugal login failed - check GOFRUGAL_USER / GOFRUGAL_PASS")
        self.role_id, self.login_id = u["roleId"], u.get("name") or user
        log.info("Gofrugal: logged in as %s", self.login_id)

    def export_csv(self, report, d_from: dt.date, d_to: dt.date) -> str:
        report_id, report_name = report
        params = {"reportId": report_id, "productId": PRODUCT_ID, "HQ_DEFA_ROLE_ID": self.role_id,
                  "popup": "false", "retail": "-1", "areaCode": "-1",
                  "fromdate": d_from.isoformat(), "todate": d_to.isoformat(),
                  "referrerProduct": "", "companyCode": "", "isHQ": "false"}
        body = {"groupby": None, "groupByLevel": None, "reportId": report_id, "reportname": report_name,
                "productId": PRODUCT_ID, "displayLength": 50, "displayStart": 0, "advFilters": [],
                "advSumFilters": [], "filters": [], "sumFilters": [], "sort": [], "needColumns": False,
                "isProcedureReport": False, "invtype": 1, "dipsQry": "Shop Name : All Shop Name",
                "currencyPattern": "##,##,##,##0.00", "currencyDecimal": "2", "dateFormat": "DD-MM-YYYY",
                "numericalDecimal": "2", "qtyDecimal": "0", "colDisplay": "", "colExport": "",
                "allFilterValue": "", "isSubGroup": False, "defaultGroupByEnabled": False,
                "isMultipleUse": 1, "isPrintPreview": False, "timeFormat": "12", "isGrouped": False,
                "entireGroupBy": "", "useSessionCache": False, "isFromSetting": False, "hidedCols": ""}
        # the report page is opened first (as in the browser), then exported
        self.s.get(f"{BASE}/smartreport/meta/", params={"reportId": report_id, "productId": PRODUCT_ID,
                   "isShortCut": "false", "referrerProduct": "", "companyCode": "", "isHQ": "false"}, timeout=60)
        r = self.s.post(f"{BASE}/smartreport/export", params={"inline": "false", "exportType": "csv", **params},
                        json=body, timeout=900)
        try:
            file_name = r.json()["fileName"]
        except (ValueError, KeyError):
            # Gofrugal's export fails when the report is EMPTY (e.g. no returns in the period).
            # Ask the on-screen data for the same report: 0 rows -> nothing to export.
            if self.row_count(report, params, body) == 0:
                log.info("Gofrugal report %s has no rows for %s..%s", report_id, d_from, d_to)
                return ""
            raise RuntimeError(f"Gofrugal export {report_id} failed ({r.status_code}): {r.text[:200]}")
        r = self.s.get(f"{BASE}/smartreport/download",
                       params={"inline": "false", "exportType": "csv", "fileName": file_name,
                               "isPivot": "false", "login_Id": self.login_id, **params}, timeout=900)
        if r.status_code != 200 or "csv" not in r.headers.get("content-type", ""):
            raise RuntimeError(f"Gofrugal download {report_id} failed ({r.status_code})")
        r.encoding = r.encoding or "utf-8"
        return r.text

    def row_count(self, report, params, body) -> int:
        """Number of rows the report has on screen for these filters (-1 if unknown)."""
        b = dict(body, displayLength=1, needColumns=False, isGridReload=True, isProcedure=True)
        b.pop("isPrintPreview", None)
        b.pop("hidedCols", None)
        r = self.s.post(f"{BASE}/smartreport/rfwDataProcess.view/reportdata", params=params, json=b, timeout=300)
        try:
            j = r.json()
        except ValueError:
            return -1
        if j.get("status") == "success" or "data" in j:
            for k in ("iTotalRecords", "recordsTotal", "totalRecords", "iTotalDisplayRecords"):
                if isinstance(j.get(k), (int, str)) and str(j.get(k)).isdigit():
                    return int(j[k])
            return len(j.get("data") or [])
        # Gofrugal also answers "Exception in report data query" for an empty period
        if "exception" in str(j.get("message", "")).lower():
            log.warning("Gofrugal report %s: export and data both say 'exception' for this period "
                        "- treated as no rows (check in Gofrugal if this repeats on busy days)",
                        body.get("reportId"))
            return 0
        return -1


# ---------------------------------------------------------------- parsing
def _num(v):
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def _date(v):
    s = str(v or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return dt.datetime.strptime(s[:10], fmt).date()
        except ValueError:
            pass
    return None


def parse_csv(text: str):
    """Gofrugal CSV -> list of dicts (title lines and total rows removed)."""
    if not text.strip():
        return []                      # empty report (see Session.export_csv)
    rows = list(csv.reader(io.StringIO(text)))
    hi = next((i for i, r in enumerate(rows) if "Outlet Name" in r), None)
    if hi is None:
        raise RuntimeError("Gofrugal CSV has no 'Outlet Name' header")
    header = [h.strip() for h in rows[hi]]
    i_out = header.index("Outlet Name")
    out = []
    for r in rows[hi + 1:]:
        if len(r) <= i_out or not r[i_out].strip():   # total line / empty line
            continue
        out.append({header[j]: (r[j].strip() if j < len(r) else "") for j in range(len(header))})
    return out


def _clinic_short(outlet):
    return re.sub(r"^\s*sanchu\s*", "", str(outlet or ""), flags=re.I).strip() or None


def sales_records(rows):
    recs = []
    for r in rows:
        d = _date(r.get("Bill Dt."))
        if not d:
            continue
        doctor = r.get("Doctor Name") or r.get("Doc Name(During Billing)") or ""
        recs.append({
            "sale_date": d, "kind": "sale", "outlet": r.get("Outlet Name"),
            "clinic": _clinic_short(r.get("Outlet Name")),
            "bill_no": r.get("Bill No"), "item_name": r.get("Item Name"),
            "manufacturer": r.get("Manufacturer"), "hsn_sac": r.get("HSN/SAC_CODE"),
            "qty": _num(r.get("Sold Qty")), "amount": round(_num(r.get("Item Amt BeforeTax")), 2),
            "tax_amount": round(_num(r.get("GST Amount")), 2),
            "net_amount": round(_num(r.get("Item Net Amt")), 2),
            "doctor": doctor.strip() or None, "salesman": r.get("SalesMan Name") or None,
            # 24 Nov 2026: customer columns, only to decide VOW (not stored)
            "_keys": vow.customer_keys([r.get(c) for c in ("Telephone", "Phone1", "Mobile No/SMS Alerts", "Mobile2")],
                                       [r.get(c) for c in ("Cust Name(During Billing)", "Cust. Name")]),
            "_dph": {p for p in (vow.phone10(r.get(c)) for c in ("Telephone (Doctor)", "Mobile No (Doctor)")) if p},
        })
    return recs


def return_records(rows):
    """Returns are stored with NEGATIVE amounts, so SUM(amount) = sales - returns."""
    recs = []
    for r in rows:
        d = _date(r.get("Return Date"))
        if not d:
            continue
        recs.append({
            "sale_date": d, "kind": "return", "outlet": r.get("Outlet Name"),
            "clinic": _clinic_short(r.get("Outlet Name")),
            "bill_no": r.get("Prefix_Ret.No") or r.get("Ret. No."), "item_name": r.get("Item Name"),
            "manufacturer": None, "hsn_sac": r.get("HSN/SAC_CODE"),
            "qty": -_num(r.get("Quantity")), "amount": -round(_num(r.get("Sub Total")), 2),
            "tax_amount": -round(_num(r.get("Tax Amt (GST)")), 2),
            "net_amount": -round(_num(r.get("Item Net Amount")), 2),
            "doctor": (r.get("Doctor Name") or "").strip() or None,
            "salesman": r.get("SalesMan Name") or None,
        })
    return recs


def apply_vow(recs, vow_doctors, customers=None):
    """vow_doctors: {(date, clinic_unit): [VetBuddy doctor names on VOW invoices]}
    customers: {(date, clinic_unit, key): {"v": first VOW invoice or "", "c": True if a clinic invoice}} (24 Nov 2026:
    the customer decides first - see vow.py "customers"; the doctor rule when the customer is not found / mixed)."""
    customers = customers or {}
    bills, use, docph = {}, {}, set()
    for r in recs:
        r["clinic_unit"], r["vow_unit"] = vow.units_for_clinic(r["outlet"])
        if r["kind"] == "sale":
            b = bills.setdefault((r["sale_date"], r["outlet"], r["bill_no"]), {"u": r["clinic_unit"], "keys": set()})
            b["keys"] |= r.get("_keys", set())
            docph |= r.get("_dph", set())
    for (d, _o, _b), b in bills.items():
        for k in b["keys"]:
            use[(d, b["u"], k)] = use.get((d, b["u"], k), 0) + 1
    decided = {}
    for (d, o, bn), b in bills.items():
        v, c = "", False
        for k in b["keys"]:
            if use[(d, b["u"], k)] > vow.SHARED_MAX or (k.startswith("p:") and k[2:] in docph):
                continue
            e = customers.get((d, b["u"], k))
            if e:
                v = v or e["v"]
                c = c or e["c"]
        decided[(d, o, bn)] = True if v and not c else False if c and not v else None
    for r in recs:
        r["doctor_code"] = vow.doctor_code(r["doctor"])
        by_doc = vow.doctor_matches(r["doctor"], vow_doctors.get((r["sale_date"], r["clinic_unit"]), ()))
        cd = decided.get((r["sale_date"], r["outlet"], r["bill_no"])) if r["kind"] == "sale" else None
        r["is_vow"] = by_doc if cd is None else cd
        r["sales_unit"] = vow.sales_unit(r["is_vow"], r["outlet"])
    return recs


def download_all(d_from: dt.date, d_to: dt.date, session: "Session" = None):
    """-> (records for the database, raw sales rows, raw return rows) for the date range."""
    gs = session or Session()
    if session is None:
        gs.login()
    sales_rows = parse_csv(gs.export_csv(SALES_REPORT, d_from, d_to))
    return_rows = parse_csv(gs.export_csv(RETURNS_REPORT, d_from, d_to))
    sales, rets = sales_records(sales_rows), return_records(return_rows)
    log.info("Gofrugal %s -> %s: %d sales lines (%.2f), %d return lines (%.2f)", d_from, d_to,
             len(sales), sum(r["amount"] for r in sales), len(rets), sum(r["amount"] for r in rets))
    return sales + rets, sales_rows, return_rows


def download(d_from: dt.date, d_to: dt.date, session: "Session" = None):
    """Sales + returns for the date range, as records (without VOW split yet)."""
    return download_all(d_from, d_to, session)[0]


# ---------------------------------------------------------------- .xlsx for SharePoint
_TEXT_COLS = re.compile(r"code|barcode|bill ?no|ret\. ?no|prefix|phone|mobile|telephone|pincode|ean|"
                        r"gst ?number|gst no|batch|billpk|tran no|refno|reference|lr no|gst billno", re.I)
_NUM_COLS = re.compile(r"qty|quantity|price|cost|mrp|rate|gross|disc|amt|amount|%|total|value|"
                       r"selling|units|stock|cess|tax|wot|charges|comm", re.I)
_DATE_COLS = re.compile(r"\bdt\b|dt\.|date", re.I)
_NUM_RE = re.compile(r"^-?[\d,]*\.?\d+$")


def _cell(col, v):
    s = (v or "").strip()
    if not s:
        return None
    if _TEXT_COLS.search(col):
        return s
    if _DATE_COLS.search(col):
        d = _date(s)
        if d and d.year > 1900:
            return d
        return s if not d else None          # 1900-01-01 = empty in Gofrugal
    if _NUM_COLS.search(col) and _NUM_RE.match(s):
        n = float(s.replace(",", ""))
        return int(n) if n.is_integer() and "." not in s else n
    return s


def to_xlsx(sales_rows, return_rows, dest, title=""):
    """Write the two Gofrugal reports as one .xlsx: sheet 'Sales' (3111) and 'Returns' (3126).
    Same columns as Gofrugal's own export; title and total rows removed."""
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in (("Sales", sales_rows), ("Returns", return_rows)):
        ws = wb.create_sheet(name)
        if not rows:
            ws["A1"] = f"No {name.lower()} in this period" + (f" ({title})" if title else "")
            continue
        header = list(rows[0].keys())
        ws.append(header)
        for c in ws[1]:
            c.font = Font(bold=True)
        for r in rows:
            ws.append([_cell(col, r.get(col)) for col in header])
        for i, col in enumerate(header, start=1):
            letter = get_column_letter(i)
            if _DATE_COLS.search(col) and not _TEXT_COLS.search(col):
                for c in ws[letter][1:]:
                    if isinstance(c.value, dt.date):
                        c.number_format = "dd-mm-yyyy"
            ws.column_dimensions[letter].width = min(max(len(col) + 2, 10), 40)
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
    wb.save(dest)
