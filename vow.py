"""
Vet on Wheels (VOW) rules – the ONE place where they live.
Same rule as the Daily Sales Report (Settings sheet: VOW rules H:I, clinic map D:F).
Used for the master sheet's "VOW Unit" column AND the bot's database.

1. A line is a VOW item if its "Services and Goods" text matches a rule below.
2. If ANY line of an invoice is a VOW item, EVERY line of that invoice is VOW.
3. The VOW unit comes from the invoice's Billed Clinic.
When the team changes the Settings sheet, change this file the same day.
"""

import re

# (rule, text) – not case-sensitive
VOW_ITEM_RULES = [
    ("contains", "VOW"),
    ("starts_with", "Home visit"),
    ("starts_with", "Nobivac"),
    ("starts_with", "Mobile Veterinary Consult"),
    ("exact", "Consultation VOW"),
]

# Billed Clinic contains <keyword>  ->  (clinic unit, VOW unit). First match wins.
CLINIC_UNITS = [
    ("Adyar",           "ADYAR",          "CH VET ON WHEELS"),
    ("Anna Nagar",      "ANNA NAGAR",     "CH VET ON WHEELS"),
    ("Velachery",       "VELACHERY",      "CH VET ON WHEELS"),
    ("Neelangarai",     "NEELANGARAI",    "CH VET ON WHEELS"),
    ("Palavakkam",      "NEELANGARAI",    "CH VET ON WHEELS"),
    ("Valasaravakkam",  "VALASARAVAKKAM", "CH VET ON WHEELS"),
    ("Coimbatore",      "COIMBATORE",     "CBE VET ON WHEELS"),
    ("Saibaba",         "COIMBATORE",     "CBE VET ON WHEELS"),
    ("Madurai",         "MADURAI",        "MADURAI VET ON WHEELS"),
    ("Trichy",          "TRICHY",         "TRICHY VET ON WHEELS"),
    ("Tiruchirappalli", "TRICHY",         "TRICHY VET ON WHEELS"),
    ("Tiruchy",         "TRICHY",         "TRICHY VET ON WHEELS"),
]

UNMAPPED_VOW = "VOW - UNMAPPED CLINIC"   # VOW invoice whose clinic matches no keyword
UNMAPPED_CLINIC = "UNMAPPED"


def is_vow_item(item) -> bool:
    if item is None:
        return False
    t = str(item).strip().lower()
    for rule, text in VOW_ITEM_RULES:
        x = text.lower()
        if (rule == "contains" and x in t) or (rule == "starts_with" and t.startswith(x)) \
                or (rule == "exact" and t == x):
            return True
    return False


def units_for_clinic(billed_clinic):
    """-> (clinic_unit, vow_unit), or (None, None) if no keyword matches."""
    b = str(billed_clinic or "").lower()
    for keyword, clinic_unit, vow_unit in CLINIC_UNITS:
        if keyword.lower() in b:
            return clinic_unit, vow_unit
    return None, None


def norm_invoice(v):
    """Invoice numbers come as 374940, 374940.0 or '374940' – make them comparable."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip().strip('"')
    if re.fullmatch(r"\d+\.0+", s):
        s = s.split(".")[0]
    return s or None


def vow_unit_for_line(invoice, billed_clinic, vow_invoices) -> str:
    """Text for the master's "VOW Unit" column: unit name, or '' for clinic sales."""
    if norm_invoice(invoice) not in vow_invoices:
        return ""
    return units_for_clinic(billed_clinic)[1] or UNMAPPED_VOW


def sales_unit(is_vow: bool, billed_clinic) -> str:
    """Which unit the sale belongs to: the VOW unit for VOW invoices, else the clinic."""
    clinic_unit, vow_unit = units_for_clinic(billed_clinic)
    if is_vow:
        return vow_unit or UNMAPPED_VOW
    return clinic_unit or UNMAPPED_CLINIC
