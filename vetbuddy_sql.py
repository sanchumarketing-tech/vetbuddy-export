"""
Load VetBuddy rows into Supabase / Postgres (table vetbuddy.sales).

Each row also gets the Vet on Wheels split (rules in vow.py, same as the master's AY):
  is_vow, clinic_unit, vow_unit, sales_unit, amount (= Net Sales - Net Return).

Daily:    replace_month(rows, (year, month), date_from, date_to)
          -> deletes that month's rows and inserts the new MTD rows, in ONE transaction
             (if anything fails, the database keeps yesterday's data untouched).
Backfill: backfill_from_master(path_to_master_xlsx)
          -> one-time load of the full history from the master workbook.

Setting (environment / GitHub secret):
  SUPABASE_DB_URL  postgresql://vb_loader.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
                   (Supabase -> Connect -> "Session pooler"; works from GitHub's servers)
"""

import datetime as dt
import logging
import os
import re
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path

import vow

log = logging.getLogger("vetbuddy")

DB_URL = os.environ.get("SUPABASE_DB_URL", "")
ENABLED = bool(DB_URL)

_EPOCH = dt.datetime(1899, 12, 30)

# VetBuddy header -> (db column, kind, max length for text)
COLUMNS = [
    ("Sr No.", "sr_no", "int", None),
    ("Client ID", "client_id", "text", 60),
    ("Client", "client_name", "text", 200),
    ("Primary Phone", "client_phone", "phone", 40),
    ("Email ID", "client_email", "text", 200),
    ("Client GST Reg No", "client_gst", "text", 40),
    ("Invoice #", "invoice_no", "code", 40),
    ("GSTN #", "gstn", "text", 40),
    ("Services and Goods", "item_name", "text", 400),
    ("Manufacturer", "manufacturer", "text", 200),
    ("Lot#", "lot_no", "text", 100),
    ("Expiry", "expiry", "text", 40),
    ("Clinic Cost", "clinic_cost", "num", None),
    ("MRP / Service Fee", "unit_price", "num", None),
    ("Qty", "qty", "num", None),
    ("Total Sales", "gross_sales", "num", None),
    ("Discount Name", "discount_name", "text", 200),
    ("Discount Type", "discount_type", "text", 100),
    ("Discount", "discount_amount", "num", None),
    ("Net Sales", "net_sales", "num", None),
    ("GST(in%)", "gst_rate", "num", None),
    ("Tax", "tax_amount", "num", None),
    ("Final Sales", "final_sales", "num", None),
    ("Return Qty", "return_qty", "num", None),
    ("Total Return", "return_gross", "num", None),
    ("Return Discount", "return_discount", "num", None),
    ("Net Return", "return_net", "num", None),
    ("Return Tax", "return_tax", "num", None),
    ("Return Total", "return_total", "num", None),
    ("Sales Person", "sales_person", "text", 200),
    ("Doctor", "doctor", "text", 200),
    ("Goods / Services", "goods_or_service", "text", 40),
    ("HSN/SAC", "hsn_sac", "code", 40),
    ("SKU", "sku", "text", 100),
    ("Brand", "brand", "text", 200),
    ("Size", "size", "text", 100),
    ("Shade", "shade", "text", 100),
    ("Sales Type", "sales_type", "text", 100),
    ("Plan Category", "plan_category", "text", 100),
    ("Plan SubCategory", "plan_subcategory", "text", 100),
    ("Patient", "patient_name", "text", 200),
    ("Species", "species", "text", 60),
    ("Breed", "breed", "text", 120),
    ("DOB", "patient_dob_text", "text", 40),
    ("Gender", "patient_gender", "text", 40),
    ("Weight", "patient_weight_kg", "num", None),
    ("Performed/Carted Clinic", "performed_clinic", "text", 200),
    ("Billed Clinic", "billed_clinic", "text", 200),
]
DB_COLS = (["sale_datetime", "sale_date"] + [c[1] for c in COLUMNS]
           + ["performed_clinic_short", "billed_clinic_short",
              "is_vow", "clinic_unit", "vow_unit", "sales_unit", "amount"])
# ---------------------------------------------------------------- cleaning
def clinic_short(name):
    """'Sanchu Animal Hospital - Anna Nagar (Division of …)' -> 'Anna Nagar'"""
    if not name:
        return None
    m = re.search(r"-\s*([^-(]+?)\s*\(", str(name))
    if m:
        return m.group(1).strip()
    return str(name).split("-")[-1].strip()[:60] or None


def _num(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(Decimal(str(v).replace(",", "").strip()))
    except (InvalidOperation, ValueError):
        return None


def _text(v, length):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s[:length] if s else None


def _code(v, length):  # invoice numbers, HSN codes: no ".0", no quotes
    s = _text(v, length)
    if s is None:
        return None
    return s.strip('"').strip() or None


def to_record(header, vals, vow_invoices=frozenset()):
    """One VetBuddy row (list of values in header order) -> dict for the database,
    or None if the row has no usable date. vow_invoices = invoice numbers that
    contain at least one Vet on Wheels item (see vow_invoice_set)."""
    idx = {str(h).strip().lower(): i for i, h in enumerate(header) if h not in (None, "")}

    def get(h):
        i = idx.get(h.lower())
        return vals[i] if i is not None and i < len(vals) else None

    d = get("Date")
    if isinstance(d, (int, float)) and not isinstance(d, bool):
        d = _EPOCH + dt.timedelta(days=float(d))
    if not isinstance(d, dt.datetime):
        return None
    rec = {"sale_datetime": d.strftime("%Y-%m-%dT%H:%M:%S"), "sale_date": d.date().isoformat()}
    for h, col, kind, length in COLUMNS:
        v = get(h)
        if kind == "num":
            rec[col] = _num(v)
        elif kind == "int":
            n = _num(v)
            rec[col] = int(n) if n is not None else None
        elif kind in ("code", "phone"):
            rec[col] = _code(v, length)
        else:
            rec[col] = _text(v, length)
    rec["performed_clinic_short"] = clinic_short(rec["performed_clinic"])
    rec["billed_clinic_short"] = clinic_short(rec["billed_clinic"])
    rec["is_vow"] = vow.norm_invoice(rec["invoice_no"]) in vow_invoices
    rec["clinic_unit"], rec["vow_unit"] = vow.units_for_clinic(rec["billed_clinic"])
    rec["sales_unit"] = vow.sales_unit(rec["is_vow"], rec["billed_clinic"])
    rec["amount"] = round((rec["net_sales"] or 0) - (rec["return_net"] or 0), 2)
    return rec


def vow_invoice_set(header, rows_iter):
    """Invoice numbers with at least one Vet on Wheels item."""
    idx = {str(h).strip().lower(): i for i, h in enumerate(header) if h not in (None, "")}
    i_inv, i_item = idx["invoice #"], idx["services and goods"]
    out = set()
    for vals in rows_iter:
        if i_item < len(vals) and vow.is_vow_item(vals[i_item]):
            out.add(vow.norm_invoice(vals[i_inv]))
    out.discard(None)
    return out


# ---------------------------------------------------------------- database
def connect():
    import psycopg  # installed by the workflow: pip install "psycopg[binary]"
    return psycopg.connect(DB_URL, connect_timeout=60, autocommit=False,
                           options="-c statement_timeout=900000")


def _insert(cur, records):
    """Fast bulk load with COPY."""
    n = 0
    with cur.copy("COPY vetbuddy.sales (" + ", ".join(DB_COLS) + ") FROM STDIN") as cp:
        for r in records:
            cp.write_row([r[c] for c in DB_COLS])
            n += 1
    return n


def replace_month(rows, month, date_from, date_to):
    """rows: header + data rows from the export. Replaces `month` in vetbuddy.sales."""
    header, data = rows[0], rows[1:]
    vow_inv = vow_invoice_set(header, data)
    records = [r for r in (to_record(header, v, vow_inv) for v in data) if r]
    skipped = len(data) - len(records)
    start = dt.date(month[0], month[1], 1)
    nxt = dt.date(month[0] + (month[1] == 12), month[1] % 12 + 1, 1)
    bad = [r for r in records if not (start.isoformat() <= r["sale_date"] < nxt.isoformat())]
    if bad:
        raise RuntimeError(f"{len(bad)} rows are outside {start:%b %Y} - database NOT changed")
    with connect() as conn:          # one transaction: all or nothing
        with conn.cursor() as cur:
            cur.execute("DELETE FROM vetbuddy.sales WHERE sale_date >= %s AND sale_date < %s",
                        (start, nxt))
            deleted = cur.rowcount
            inserted = _insert(cur, records)
            cur.execute("INSERT INTO vetbuddy.load_log (month_start, date_from, date_to, "
                        "rows_deleted, rows_inserted, kind) VALUES (%s, %s, %s, %s, %s, 'daily')",
                        (start, date_from, date_to, deleted, inserted))
    log.info("Database: removed %d rows of %02d/%d, added %d rows (%d VOW invoices)%s", deleted,
             month[1], month[0], inserted, len(vow_inv),
             f" ({skipped} rows without a date skipped)" if skipped else "")


# ---------------------------------------------------------------- backfill
def iter_master_rows(path):
    """Stream the master workbook: yields the header list, then each data row
    as a list of values (column B as datetime). Low memory, ~1 min for 300k rows."""
    from xml.etree.ElementTree import iterparse
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for _, el in iterparse(z.open("xl/sharedStrings.xml")):
            if el.tag == ns + "si":
                ss.append("".join(el.itertext()))
                el.clear()

    def col_index(ref):
        letters = re.match(r"[A-Z]+", ref).group(0)
        n = 0
        for ch in letters:
            n = n * 26 + ord(ch) - 64
        return n - 1

    for _, row in iterparse(z.open("xl/worksheets/sheet1.xml")):
        if row.tag != ns + "row":
            continue
        vals = [None] * 49
        for c in row.findall(ns + "c"):
            i = col_index(c.get("r"))
            if i >= 49:  # AX (date formula) and beyond: not needed
                continue
            t = c.get("t")
            v = c.find(ns + "v")
            if t == "s" and v is not None:
                vals[i] = ss[int(v.text)]
            elif t == "inlineStr":
                vals[i] = "".join(c.find(ns + "is").itertext())
            elif t in ("str", "e") and v is not None:
                vals[i] = v.text
            elif t == "b" and v is not None:
                vals[i] = v.text == "1"
            elif v is not None and v.text is not None:
                try:
                    vals[i] = float(v.text)
                except ValueError:
                    vals[i] = v.text
        row.clear()
        yield vals


def backfill_from_master(path):
    """One-time: replace ALL rows in dbo.sales with the master workbook's rows."""
    it = iter_master_rows(path)
    header = next(it)
    log.info("Backfill: finding Vet on Wheels invoices...")
    scan = iter_master_rows(path)
    next(scan)
    vow_inv = vow_invoice_set(header, scan)
    if str(header[1]).strip().lower() != "date" or str(header[0]).strip().lower() != "sr no.":
        raise RuntimeError(f"Master header looks wrong: {header[:4]} - database NOT changed")
    total = skipped = 0

    def records():
        nonlocal skipped
        for vals in it:
            if all(v in (None, "") for v in vals):
                continue
            rec = to_record(header, vals, vow_inv)
            if rec is None:
                skipped += 1
                continue
            yield rec

    with connect() as conn:          # one transaction: all or nothing
        with conn.cursor() as cur:
            cur.execute("DELETE FROM vetbuddy.sales")
            deleted = cur.rowcount
            total = _insert(cur, records())
            cur.execute("INSERT INTO vetbuddy.load_log (rows_deleted, rows_inserted, kind) "
                        "VALUES (%s, %s, 'backfill')", (deleted, total))
    log.info("Backfill done: %d rows loaded, %d VOW invoices (%d rows without a date skipped)",
             total, len(vow_inv), skipped)


# ---------------------------------------------------------------- pharmacy (Gofrugal)
PHARM_COLS = ["sale_date", "kind", "outlet", "clinic", "bill_no", "item_name", "manufacturer",
              "hsn_sac", "qty", "amount", "tax_amount", "net_amount", "doctor", "doctor_code",
              "salesman", "is_vow", "clinic_unit", "vow_unit", "sales_unit"]


def vow_doctors(cur, d_from, d_to):
    """{(date, clinic_unit): [doctor names]} of VetBuddy VOW invoices – used to split pharmacy."""
    cur.execute("SELECT DISTINCT sale_date, clinic_unit, doctor FROM vetbuddy.sales "
                "WHERE is_vow AND sale_date BETWEEN %s AND %s AND doctor IS NOT NULL", (d_from, d_to))
    out = {}
    for d, cu, doc in cur.fetchall():
        out.setdefault((d, cu), []).append(doc)
    return out


def vow_customers(cur, d_from, d_to):
    """{(date, clinic_unit, "p:phone" / "n:name"): {"v": first VOW invoice, "c": clinic invoice?}} from VetBuddy."""
    import vow
    cur.execute("SELECT DISTINCT sale_date, clinic_unit, invoice_no, is_vow, client_phone, client_name FROM vetbuddy.sales "
                "WHERE sale_date BETWEEN %s AND %s AND clinic_unit IS NOT NULL", (d_from, d_to))
    out = {}
    for d, cu, inv, isv, ph, nm in cur.fetchall():
        for k in vow.customer_keys([ph], [nm]):
            e = out.setdefault((d, cu, k), {"v": "", "c": False})
            if isv:
                e["v"] = e["v"] or inv
            else:
                e["c"] = True
    return out


def replace_pharmacy(recs, d_from, d_to):
    """Replace pharmacy rows of [d_from, d_to] with recs (after the VOW split), all or nothing."""
    import gofrugal
    bad = [r for r in recs if not (d_from <= r["sale_date"] <= d_to)]
    if bad:
        raise RuntimeError(f"{len(bad)} pharmacy rows are outside {d_from}..{d_to} - database NOT changed")
    with connect() as conn:
        with conn.cursor() as cur:
            gofrugal.apply_vow(recs, vow_doctors(cur, d_from, d_to), vow_customers(cur, d_from, d_to))
            cur.execute("DELETE FROM vetbuddy.pharmacy_sales WHERE sale_date BETWEEN %s AND %s",
                        (d_from, d_to))
            deleted = cur.rowcount
            with cur.copy("COPY vetbuddy.pharmacy_sales (" + ", ".join(PHARM_COLS) + ") FROM STDIN") as cp:
                for r in recs:
                    cp.write_row([r[c] for c in PHARM_COLS])
    vow_amt = sum(r["amount"] for r in recs if r["is_vow"])
    log.info("Pharmacy: removed %d rows, added %d rows for %s..%s (total %.2f, of which VOW %.2f)",
             deleted, len(recs), d_from, d_to, sum(r["amount"] for r in recs), vow_amt)
