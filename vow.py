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

# Gofrugal (pharmacy) bills: a bill is VOW when the SAME DOCTOR billed a VOW invoice in
# VetBuddy on the SAME DATE at the SAME CLINIC. Doctors are matched by their code
# (P0xxxx in the name) first, otherwise by name (spelling differences allowed).
# Names that can't be matched automatically: Gofrugal doctor name -> VetBuddy doctor code.
DOCTOR_NAME_OVERRIDES = {
    "vamshi dr": "P00186",            # Dr Bandi Vamsi Krishna
}
NAME_MATCH_MIN = 0.80                 # 0..1 – how similar two doctor names must be

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


def doctor_code(name):
    """'Dr Vairavasamy K P00158' / 'K Nivedha-P00005' -> 'P00158' / 'P00005' (or None)."""
    m = re.search(r"\bP\s*0*(\d{2,6})\b", str(name or ""), re.I) or \
        re.search(r"P0*(\d{2,6})\s*$", str(name or ""), re.I)
    return f"P{int(m.group(1)):05d}" if m else None


def doctor_name_key(name) -> str:
    """Name without titles, codes and punctuation: 'DR .UNNIMAYA P00185' -> 'unnimaya'."""
    t = str(name or "").lower()
    t = re.sub(r"\bp\s*0*\d{2,6}\b", " ", t)
    t = re.sub(r"[^a-z ]", " ", t)
    words = [w for w in t.split() if w not in ("dr", "doctor", "drs") and len(w) > 1]
    return " ".join(words)


def doctor_matches(pharmacy_doctor, vow_doctors) -> bool:
    """True if the Gofrugal doctor is one of the VetBuddy VOW doctors (same day, same clinic).
    vow_doctors: iterable of VetBuddy doctor names."""
    from difflib import SequenceMatcher
    if not pharmacy_doctor:
        return False
    code = doctor_code(pharmacy_doctor) or DOCTOR_NAME_OVERRIDES.get(str(pharmacy_doctor).strip().lower())
    vow_doctors = list(vow_doctors)
    if code:
        return any(doctor_code(d) == code for d in vow_doctors)
    key = doctor_name_key(pharmacy_doctor)
    if not key:
        return False
    for d in vow_doctors:
        k2 = doctor_name_key(d)
        if not k2:
            continue
        a, b = set(key.split()), set(k2.split())
        if a <= b or b <= a or SequenceMatcher(None, key, k2).ratio() >= NAME_MATCH_MIN:
            return True
    return False


def sales_unit(is_vow: bool, billed_clinic) -> str:
    """Which unit the sale belongs to: the VOW unit for VOW invoices, else the clinic."""
    clinic_unit, vow_unit = units_for_clinic(billed_clinic)
    if is_vow:
        return vow_unit or UNMAPPED_VOW
    return clinic_unit or UNMAPPED_CLINIC
