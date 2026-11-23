#!/usr/bin/env python3
"""Read only (23 Nov 2026): what would change if a Gofrugal bill with a Nobivac item counted as Vet on Wheels
(the same item rule VetBuddy uses). Every unit, FROM..TO. No phone numbers or names printed.
For each Gofrugal sale bill with a Nobivac line:
  A  already VoW (doctor rule)                       - no change
  B  clinic now, customer has a VoW invoice that day  - missed VoW (would move: correct)
  C  clinic now, customer has only clinic invoices    - a clinic vaccination (would move: WRONG)
  D  clinic now, customer not found in VetBuddy (+-1 day) - unknown
Also: VoW invoices in VetBuddy with a Nobivac line, and whether the customer has a Gofrugal Nobivac bill.
Env: SUPABASE_DB_URL, GOFRUGAL_USER/PASS, FROM, TO."""
import collections, datetime as dt, os, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
import gofrugal, vow

d_from = dt.date.fromisoformat(os.environ["FROM"]); d_to = dt.date.fromisoformat(os.environ["TO"])
ph = lambda v: re.sub(r"\D", "", str(v or ""))[-10:] if len(re.sub(r"\D", "", str(v or ""))) >= 10 else None
nm = lambda v: " ".join(w for w in re.sub(r"[^a-z ]", " ", str(v or "").lower()).split() if w not in ("mr", "mrs", "ms", "dr", "miss"))
NOB = re.compile(r"nobivac|^nob\b", re.I)

with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as c, c.cursor() as cur:
    cur.execute("""select sale_date, clinic_unit, invoice_no, is_vow, doctor, client_name, client_phone, item_name, coalesce(amount,0)
                     from vetbuddy.sales where sale_date between %s and %s""", (d_from - dt.timedelta(days=1), d_to + dt.timedelta(days=1)))
    vb = cur.fetchall()
inv = {}
vow_docs = collections.defaultdict(set)
for d, cu, no, isv, doc, cn, cp, item, amt in vb:
    e = inv.setdefault((cu, no), {"d": d, "cu": cu, "vow": bool(isv), "keys": set(), "nob": False, "amt": 0.0, "nobamt": 0.0})
    e["amt"] += float(amt)
    if nm(cn): e["keys"].add(("n", nm(cn)))
    if ph(cp): e["keys"].add(("p", ph(cp)))
    if NOB.search(str(item or "")): e["nob"] = True; e["nobamt"] += float(amt)
    if isv: vow_docs[(d, cu)].add(doc)
idx = collections.defaultdict(list)            # (unit, day, key) -> invoices
for e in inv.values():
    for k in e["keys"]:
        idx[(e["cu"], e["d"], k)].append(e)

gs = gofrugal.Session(); gs.login()
rows = gofrugal.parse_csv(gs.export_csv(gofrugal.SALES_REPORT, d_from, d_to))
bills = collections.OrderedDict()
for r in rows:
    d = gofrugal._date(r.get("Bill Dt.")); cu = vow.units_for_clinic(r.get("Outlet Name"))[0]
    b = bills.setdefault((cu, r.get("Outlet Name"), r.get("Bill No"), d), {"doc": (r.get("Doctor Name") or r.get("Doc Name(During Billing)") or "").strip(),
                                                                         "bt": 0.0, "nobbt": 0.0, "nob": [], "keys": set()})
    amt = gofrugal._num(r.get("Item Amt BeforeTax")); b["bt"] += amt
    if NOB.search(str(r.get("Item Name") or "")):
        b["nob"].append(str(r.get("Item Name"))); b["nobbt"] += amt
    for pc in ("Telephone", "Phone1", "Mobile No/SMS Alerts", "Mobile2"):
        if ph(r.get(pc)): b["keys"].add(("p", ph(r.get(pc))))
    for nc in ("Cust Name(During Billing)", "Cust. Name"):
        if nm(r.get(nc)): b["keys"].add(("n", nm(r.get(nc))))
key_use = collections.Counter(k for b in bills.values() for k in b["keys"])

cat = collections.defaultdict(lambda: collections.Counter())
lines = collections.defaultdict(list)
gf_nob_cust = set()
for (cu, outlet, no, d), b in bills.items():
    if not b["nob"]:
        continue
    keys = {k for k in b["keys"] if key_use[k] <= 5}       # shared numbers / names are not proof
    for k in keys: gf_nob_cust.add((cu, d, k))
    isv = vow.doctor_matches(b["doc"], vow_docs.get((d, cu), ()))
    same = [e for k in keys for e in idx.get((cu, d, k), [])]
    near = [e for k in keys for dd in (d - dt.timedelta(days=1), d + dt.timedelta(days=1)) for e in idx.get((cu, dd, k), [])]
    if isv: c_ = "A"
    elif any(e["vow"] for e in same): c_ = "B"
    elif same: c_ = "C"
    elif any(e["vow"] for e in near): c_ = "B+-1d"
    elif near: c_ = "C+-1d"
    else: c_ = "D" + (" (shared/no customer)" if not keys else "")
    cat[cu][c_ + " bills"] += 1; cat[cu][c_ + " amount"] += b["bt"]
    vbtxt = ", ".join(sorted({f"{e['d']:%d-%b} {'VoW' if e['vow'] else 'clinic'}{' Nobivac' if e['nob'] else ''}" for e in (same or near)})) or "-"
    lines[cu].append(f"  {d}  {no:8} {c_:22} {b['doc'][:24]:24} bill {b['bt']:>9,.2f} (Nobivac {b['nobbt']:>8,.2f})  VetBuddy: {vbtxt}  items: {'; '.join(sorted(set(b['nob'])))[:70]}")

print(f"Gofrugal sale bills with a Nobivac line, {d_from}..{d_to} (before tax)")
for cu in sorted(lines, key=str):
    print(f"\n=== {cu}")
    print("\n".join(sorted(lines[cu])))
    for k in sorted(cat[cu]):
        v = cat[cu][k]
        print(f"   {k:36} {v:>12,.2f}" if "amount" in k else f"   {k:36} {v:>9}")

print("\n=== VetBuddy VoW invoices with a Nobivac line: does the customer have a Gofrugal Nobivac bill that day?")
vc = collections.Counter()
for e in inv.values():
    if e["vow"] and e["nob"] and d_from <= e["d"] <= d_to:
        has = any((e["cu"], e["d"], k) in gf_nob_cust for k in e["keys"])
        vc[(e["cu"], has)] += 1
for (cu, has), n in sorted(vc.items(), key=str):
    print(f"   {cu:15} {'with' if has else 'without'} a Gofrugal Nobivac bill: {n}")
print("\n=== Clinic (not VoW) VetBuddy invoices with a Nobivac line:",
      sum(1 for e in inv.values() if not e["vow"] and e["nob"] and d_from <= e["d"] <= d_to), "(should be 0 - VetBuddy's rule makes them VoW)")
