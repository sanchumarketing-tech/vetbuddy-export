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

    def login(self):
        self.s.get(f"{BASE}/RayMedi_HQ/mainIndex.do", timeout=60)          # login page + session
        self.s.post(f"{BASE}/RayMedi_HQ/j_security_check",
                    data={"j_username": USER, "j_password": PASSWORD}, timeout=120)
        self.s.get(f"{BASE}/smartreport/index.html", timeout=60)             # report module session
        r = self.s.get(f"{BASE}/smartreport/user",
                       params={"referrerProduct": "", "companyCode": "", "isHQ": "false"}, timeout=60)
        try:
            u = r.json()
        except ValueError:
            u = {}
        if r.status_code != 200 or not u.get("roleId"):
            raise RuntimeError("Gofrugal login failed - check GOFRUGAL_USER / GOFRUGAL_PASS")
        self.role_id, self.login_id = u["roleId"], u.get("name") or USER
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
            raise RuntimeError(f"Gofrugal export {report_id} failed ({r.status_code}): {r.text[:200]}")
        r = self.s.get(f"{BASE}/smartreport/download",
                       params={"inline": "false", "exportType": "csv", "fileName": file_name,
                               "isPivot": "false", "login_Id": self.login_id, **params}, timeout=900)
        if r.status_code != 200 or "csv" not in r.headers.get("content-type", ""):
            raise RuntimeError(f"Gofrugal download {report_id} failed ({r.status_code})")
        r.encoding = r.encoding or "utf-8"
        return r.text


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


def apply_vow(recs, vow_doctors):
    """vow_doctors: {(date, clinic_unit): [VetBuddy doctor names on VOW invoices]}"""
    for r in recs:
        clinic_unit, vow_unit = vow.units_for_clinic(r["outlet"])
        r["doctor_code"] = vow.doctor_code(r["doctor"])
        r["clinic_unit"], r["vow_unit"] = clinic_unit, vow_unit
        r["is_vow"] = vow.doctor_matches(r["doctor"], vow_doctors.get((r["sale_date"], clinic_unit), ()))
        r["sales_unit"] = vow.sales_unit(r["is_vow"], r["outlet"])
    return recs


def download(d_from: dt.date, d_to: dt.date, session: "Session" = None):
    """Sales + returns for the date range, as records (without VOW split yet)."""
    gs = session or Session()
    if session is None:
        gs.login()
    sales = sales_records(parse_csv(gs.export_csv(SALES_REPORT, d_from, d_to)))
    rets = return_records(parse_csv(gs.export_csv(RETURNS_REPORT, d_from, d_to)))
    log.info("Gofrugal %s -> %s: %d sales lines (%.2f), %d return lines (%.2f)", d_from, d_to,
             len(sales), sum(r["amount"] for r in sales), len(rets), sum(r["amount"] for r in rets))
    return sales + rets
