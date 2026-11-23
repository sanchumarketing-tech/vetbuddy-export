#!/usr/bin/env python3
"""Read only: verify Vet on Wheels pharmacy bills by phone number (23 Nov 2026).

Each Gofrugal bill of the clinic's outlet (report 3111) is put next to the VetBuddy invoices with the SAME
customer phone number at the same clinic, same day (from vetbuddy.sales):
  OK            Gofrugal bill counted as VoW, and the phone has a VoW invoice in VetBuddy that day
  CLINIC?       counted as VoW, but the phone has only clinic (not VoW) invoices that day
  NO MATCH      counted as VoW, but the phone has no VetBuddy invoice that day (or no phone on the bill)
  MISSED VoW    NOT counted as VoW, but the phone has only VoW invoices that day
Phone numbers are shown as the last 4 digits only.
Env: SUPABASE_DB_URL, GOFRUGAL_USER/PASS, FROM, TO (YYYY-MM-DD), CLINIC (default Coimbatore)."""
import collections, datetime as dt, os, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
import gofrugal, vow

d_from = dt.date.fromisoformat(os.environ["FROM"]); d_to = dt.date.fromisoformat(os.environ["TO"])
clinic = os.environ.get("CLINIC") or "Coimbatore"
ph = lambda v: (re.sub(r"\D", "", str(v or ""))[-10:] or None) if len(re.sub(r"\D", "", str(v or ""))) >= 10 else None

gs = gofrugal.Session(); gs.login()
rows = gofrugal.parse_csv(gs.export_csv(gofrugal.SALES_REPORT, d_from, d_to))
if rows:
    print("Gofrugal columns:", list(rows[0].keys()))
pcols = [k for k in (rows[0].keys() if rows else []) if re.search(r"mobile|phone|cell|contact|telephone", k, re.I) and not re.search(r"doc", k, re.I)]
ncols = [k for k in ("Cust Name(During Billing)", "Cust. Name") if rows and k in rows[0]]
nm = lambda v: " ".join(w for w in re.sub(r"[^a-z ]", " ", str(v or "").lower()).split() if w not in ("mr", "mrs", "ms", "dr", "miss"))
print("phone columns used:", pcols, "name columns:", ncols)
cu = vow.units_for_clinic(f"Sanchu {clinic}")[0]
rows = [r for r in rows if vow.units_for_clinic(r.get("Outlet Name"))[0] == cu]

with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as c, c.cursor() as cur:
    cur.execute("""select sale_date, invoice_no, client_phone, is_vow, doctor, client_name,
                          sum(coalesce(amount,0)) from vetbuddy.sales
                    where sale_date between %s and %s and clinic_unit = %s
                    group by 1,2,3,4,5,6""", (d_from, d_to, cu))
    vb = cur.fetchall()
vow_docs = collections.defaultdict(set)
by_key = collections.defaultdict(dict)
for d, inv, p, isv, doc, cname, amt in vb:
    if isv:
        vow_docs[(d, cu)].add(doc)
    for k in ([("p", ph(p))] if ph(p) else []) + ([("n", nm(cname))] if nm(cname) else []):
        for dd in (d - dt.timedelta(days=1), d, d + dt.timedelta(days=1)):
            e = by_key[(dd, k)].setdefault(inv, [bool(isv), 0.0, d])
            e[1] += float(amt)

bills = collections.OrderedDict()
for r in rows:
    d = gofrugal._date(r.get("Bill Dt."))
    k = (d, r.get("Bill No"))
    b = bills.setdefault(k, {"amt": 0.0, "doctor": (r.get("Doctor Name") or r.get("Doc Name(During Billing)") or "").strip(),
                             "keys": set()})
    b["amt"] += gofrugal._num(r.get("Item Amt BeforeTax"))
    for pc in pcols:
        if ph(r.get(pc)):
            b["keys"].add(("p", ph(r.get(pc))))
    for nc in ncols:
        if nm(r.get(nc)):
            b["keys"].add(("n", nm(r.get(nc))))
count = collections.Counter(); amt = collections.Counter()
lines = []
for (d, no), b in sorted(bills.items()):
    isv = vow.doctor_matches(b["doctor"], vow_docs.get((d, cu), ()))
    found = {}
    how = set()
    for k in b["keys"]:
        for inv, e in by_key.get((d, k), {}).items():
            found[inv] = e; how.add({"p": "phone", "n": "name"}[k[0]] + ("" if e[2] == d else " +-1d"))
    m = [(i, e[0], e[1]) for i, e in found.items()]
    has_v, has_c = any(x[1] for x in m), any(not x[1] for x in m)
    if isv:
        st = "OK" if has_v else ("CLINIC?" if has_c else "NO MATCH")
    else:
        st = "MISSED VoW" if (has_v and not has_c) else ("clinic" if True else "")
    count[st] += 1; amt[st] += b["amt"]
    if isv or st == "MISSED VoW":
        vb_txt = ", ".join(f"{i}{'(VoW)' if v else '(clinic)'} {a:,.0f}" for i, v, a in m) or "-"
        lines.append(f"{d}  {no:9} {b['amt']:>10,.2f}  {b['doctor'][:26]:26} {st:10} by {'/'.join(sorted(how)) or '-':14} VetBuddy: {vb_txt}")
print(f"\nCoimbatore Gofrugal bills {d_from}..{d_to}: VoW bills and possible missed VoW bills")
print("\n".join(lines))
print("\nSummary (bills, before-tax amount):")
for st in ("OK", "CLINIC?", "NO MATCH", "MISSED VoW", "clinic"):
    print(f"  {st:10} {count[st]:5}  {amt[st]:>12,.2f}")
