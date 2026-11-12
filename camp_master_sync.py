#!/usr/bin/env python3
"""
Camp master: SharePoint Excel -> Supabase (vetbuddy.camp_master), for the Teams bot.

The team keeps "Sanchu Reports/Camp Master.xlsx" (sanchureports OneDrive), sheet "Camps", one row per camp item:
  Camp Name | Camp Type | Camp Dates | Locations | Item | Goods / Service | Match Keywords | Species |
  Original Price | Camp Price | Notes
  - Camp Dates: one or more dates, comma separated (2026-11-11, 2026-11-18 or 11-11-2026) or an Excel date
  - Locations: All, or cities / clinics (Chennai, Coimbatore, Madurai, Trichy, Adyar, Anna Nagar ...), comma separated
  - Match Keywords: words found in the VetBuddy / pharmacy item names, comma separated
    (e.g. "Wednesday Neem Bath" or "DHPPI"); empty = the Item name itself
Every run (GitHub Actions, daily and on demand) replaces the whole table with the sheet's rows.
If the workbook does not exist yet, it is created with the instructions and the November 2026 Wednesday Camp.

Usage: python camp_master_sync.py            (env: SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SUPABASE_DB_URL,
                                               SP_CAMP_SITE_URL, SP_CAMP_LIBRARY, SP_CAMP_MASTER_PATH)
"""
import datetime as dt
import io
import logging
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corefactor_calllogs_export as cf   # noqa: E402  SharePoint helper
import vetbuddy_sql                       # noqa: E402  Supabase connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("camp")

MASTER = os.environ.get("SP_CAMP_MASTER_PATH") or "Sanchu Reports/Camp Master.xlsx"
COLS = ["Camp Name", "Camp Type", "Camp Dates", "Locations", "Item", "Goods / Service", "Match Keywords",
        "Species", "Original Price", "Camp Price", "Notes"]

CITY_UNITS = {
    "chennai": ["ADYAR", "NEELANGARAI", "ANNA NAGAR", "VELACHERY", "VALASARAVAKKAM", "CH VET ON WHEELS", "CH VET ON WHEELS - NON CLINICAL"],
    "coimbatore": ["COIMBATORE", "CBE VET ON WHEELS", "CBE VET ON WHEELS - NON CLINICAL"],
    "madurai": ["MADURAI", "MADURAI VET ON WHEELS"],
    "trichy": ["TRICHY", "TRICHY VET ON WHEELS"],
}
ALL_UNITS = sorted({u for v in CITY_UNITS.values() for u in v})
ALIASES = {"cbe": "coimbatore", "kovai": "coimbatore", "ch": "chennai", "tiruchi": "trichy", "tiruchirappalli": "trichy"}
CLINICS = {"adyar": "ADYAR", "neelangarai": "NEELANGARAI", "anna nagar": "ANNA NAGAR", "velachery": "VELACHERY",
           "valasaravakkam": "VALASARAVAKKAM"}

D = "2026-11-11, 2026-11-18, 2026-11-25"
SEED = [  # Wednesday Camp, November 2026 (from the camp poster)
    ["Wednesday Camp", "Non-Clinical", D, "Chennai", "Neem Bath", "Service", "Wednesday Neem Bath", "Dog/Cat", 580, 290, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Chennai", "Nail Trim", "Service", "Wednesday Nail Trim", "Dog/Cat", 249, 124.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Chennai", "Anal Gland Cleaning", "Service", "Wednesday Anal Gland", "Dog/Cat", 245, 122.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Chennai", "Ear Cleaning", "Service", "Wednesday Ear Clean", "Dog/Cat", 245, 122.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Chennai", "Paw Massage (Pawdicure)", "Service", "Wednesday Pawdicure, Wednesday Paw", "Dog/Cat", 199, 99.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Coimbatore, Madurai", "Neem Bath", "Service", "Wednesday Neem Bath", "Dog/Cat", 580, 290, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Coimbatore, Madurai", "Nail Trim", "Service", "Wednesday Nail Trim", "Dog/Cat", 179, 89.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Coimbatore, Madurai", "Anal Gland Cleaning", "Service", "Wednesday Anal Gland", "Dog/Cat", 159, 79.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Coimbatore, Madurai", "Ear Cleaning", "Service", "Wednesday Ear Clean", "Dog/Cat", 179, 89.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "Coimbatore, Madurai", "Paw Massage (Pawdicure)", "Service", "Wednesday Pawdicure, Wednesday Paw", "Dog/Cat", 159, 79.5, ""],
    ["Wednesday Camp", "Non-Clinical", D, "All", "Day Care Boarding (8 AM - 8 PM)", "Service", "Day Care, Daycare", "Dog/Cat", None, 220, "Camp price only on the poster"],
    ["Wednesday Camp", "Clinical", D, "All", "DHPPI + L4 vaccine", "Goods + Service", "DHPPI", "Dog", 1603, 801.5, "Also matches DHPPI combos"],
    ["Wednesday Camp", "Clinical", D, "All", "Rabies vaccine", "Goods + Service", "Rabies", "Dog", 803, 401.5, ""],
    ["Wednesday Camp", "Clinical", D, "All", "KC (Kennel Cough) vaccine", "Goods + Service", "Kennel", "Dog/Cat", 1603, 801.5, ""],
    ["Wednesday Camp", "Clinical", D, "All", "Tricat vaccine", "Goods + Service", "Tricat", "Cat", 1603, 801.5, ""],
    ["Wednesday Camp", "Clinical", D, "All", "DHPPI + L4 + Rabies", "Goods + Service", "DHPPI+L4+ARV, DHPPI + L4 + ARV, DHPPIL + ARV, DHPPI+L+ARV", "Dog", 1926, 963, "Combo"],
    ["Wednesday Camp", "Clinical", D, "All", "Tricat + Rabies", "Goods + Service", "Tricat + Rabies, Tricat+Rabies, Tricat + ARV, Tricat+ARV", "Cat", 1926, 963, "Combo"],
]
HOW_TO = [
    ["Camp Master - how to fill it"],
    [""],
    ["One row per camp item (service or product). Repeat the camp name on every row of that camp."],
    ["Camp Name", "Any name, e.g. Wednesday Camp, Diwali Grooming Week"],
    ["Camp Type", "Clinical / Non-Clinical / Other"],
    ["Camp Dates", "All dates of the camp, comma separated: 2026-11-11, 2026-11-18 (or 11-11-2026). A range: 2026-12-01 to 2026-12-07"],
    ["Locations", "All, or cities / clinics: Chennai, Coimbatore, Madurai, Trichy, Adyar, Anna Nagar, Velachery, Neelangarai, Valasaravakkam"],
    ["Item", "The service / product as you call it"],
    ["Goods / Service", "Goods, Service or Goods + Service"],
    ["Match Keywords", "Words that appear in the VetBuddy / pharmacy item name, comma separated (e.g. Wednesday Neem Bath). Empty = the Item name"],
    ["Species", "Dog, Cat, Dog/Cat (optional)"],
    ["Original Price / Camp Price", "Rs (optional)"],
    ["Notes", "Anything else (optional)"],
    [""],
    ["The bot reads this sheet every morning (and when the 'Camp master sync' workflow is run). Ask it e.g. 'how did the Wednesday camp do?'."],
]


def to_dates(v):
    if v is None or v == "":
        return []
    if isinstance(v, dt.datetime):
        return [v.date()]
    if isinstance(v, dt.date):
        return [v]
    out = []
    for part in re.split(r"[,;\n]+", str(v)):
        part = part.strip()
        if not part:
            continue
        rng = re.split(r"\s+(?:to|-|–)\s+", part)
        if len(rng) == 2 and all(one_date(x) for x in rng):
            a, b = one_date(rng[0]), one_date(rng[1])
            out += [a + dt.timedelta(days=i) for i in range((b - a).days + 1)] if b >= a else []
        elif one_date(part):
            out.append(one_date(part))
        else:
            raise ValueError(f"cannot read date '{part}'")
    return sorted(set(out))


def one_date(s):
    s = s.strip()
    for f in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y"):
        try:
            return dt.datetime.strptime(s, f).date()
        except ValueError:
            pass
    return None


def to_units(v):
    txt = str(v or "All").strip().lower()
    if txt in ("", "all", "all locations", "all units", "division"):
        return ALL_UNITS
    out = []
    for part in re.split(r"[,;&/]+|\band\b", txt):
        p = ALIASES.get(part.strip(), part.strip())
        if not p:
            continue
        if p in CITY_UNITS:
            out += CITY_UNITS[p]
        elif p in CLINICS:
            out.append(CLINICS[p])
        elif p.upper() in ALL_UNITS:
            out.append(p.upper())
        else:
            raise ValueError(f"unknown location '{part.strip()}'")
    return sorted(set(out))


def num(v):
    if v in (None, ""):
        return None
    try:
        return float(str(v).replace(",", "").replace("₹", "").replace("Rs", "").strip())
    except ValueError:
        return None


def new_workbook():
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    wb = Workbook()
    ws = wb.active
    ws.title = "Camps"
    ws.append(COLS)
    for r in SEED:
        ws.append(r)
    for c in ws[1]:
        c.font, c.fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="1F3864")
    for col, w in zip("ABCDEFGHIJK", [18, 13, 34, 20, 30, 15, 34, 10, 13, 11, 28]):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:K{ws.max_row}"
    hw = wb.create_sheet("How to fill")
    for r in HOW_TO:
        hw.append(r)
    hw["A1"].font = Font(bold=True, size=13)
    hw.column_dimensions["A"].width = 28
    hw.column_dimensions["B"].width = 110
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def read_rows(data):
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), data_only=True)
    ws = wb["Camps"] if "Camps" in wb.sheetnames else wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    hdr = [cf.norm(h) for h in next(it)]
    ix = {c: hdr.index(cf.norm(c)) for c in COLS if cf.norm(c) in hdr}
    missing = [c for c in ("Camp Name", "Camp Dates", "Item") if c not in ix]
    if missing:
        raise RuntimeError(f"Camp Master: columns missing: {missing}")
    rows, problems = [], []
    for n, r in enumerate(it, start=2):
        g = lambda c: (r[ix[c]] if c in ix and ix[c] < len(r) else None)   # noqa: E731
        name, item = str(g("Camp Name") or "").strip(), str(g("Item") or "").strip()
        if not name and not item:
            continue
        try:
            dates = to_dates(g("Camp Dates"))
            units = to_units(g("Locations"))
            if not name or not item or not dates:
                raise ValueError("Camp Name, Item and Camp Dates are needed")
        except ValueError as e:
            problems.append(f"row {n}: {e}")
            continue
        kws = [k.strip() for k in str(g("Match Keywords") or item).split(",") if k.strip()]
        rows.append((n, name, str(g("Camp Type") or "").strip() or None, dates, str(g("Locations") or "All").strip(), units, item,
                     str(g("Goods / Service") or "").strip() or None, kws, str(g("Species") or "").strip() or None,
                     num(g("Original Price")), num(g("Camp Price")), str(g("Notes") or "").strip() or None))
    return rows, problems


def main():
    sp = cf.SharePoint.from_env("SP_CAMP_SITE_URL", "SP_CAMP_LIBRARY")
    try:
        data, _ = sp.download(MASTER)
    except cf.RunError as e:
        if "404" not in str(e):
            raise
        log.info("%s not found - creating it with the November 2026 Wednesday Camp", MASTER)
        data = new_workbook()
        sp.ensure_folder(MASTER.rsplit("/", 1)[0])
        sp.upload(MASTER, data)
    rows, problems = read_rows(data)
    for p in problems:
        log.warning("Skipped %s", p)
    if not rows:
        log.error("No camp rows read - database not changed")
        return 1
    with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
        cur.execute("delete from vetbuddy.camp_master")
        cur.executemany("""insert into vetbuddy.camp_master (row_no, camp_name, camp_type, camp_dates, locations, units, item,
            goods_or_service, match_keywords, species, original_price, camp_price, notes) values
            (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", rows)
        conn.commit()
    camps = sorted({r[1] for r in rows})
    log.info("Camp master loaded: %d items in %d camp(s): %s%s", len(rows), len(camps), ", ".join(camps),
             f" ({len(problems)} row(s) skipped)" if problems else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
