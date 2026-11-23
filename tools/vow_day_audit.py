#!/usr/bin/env python3
"""Read only: full audit of one clinic's Vet on Wheels figure for one day (23 Nov 2026).
VetBuddy (vetbuddy.sales) + Gofrugal (live reports 3111 sales / 3126 returns). No phone numbers printed.
Env: SUPABASE_DB_URL, GOFRUGAL_USER/PASS, DAY (YYYY-MM-DD), CLINIC (default Coimbatore)."""
import collections, datetime as dt, os, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
import gofrugal, vow

day = dt.date.fromisoformat(os.environ["DAY"]); clinic = os.environ.get("CLINIC") or "Coimbatore"
cu, vu = vow.units_for_clinic(f"Sanchu {clinic}")
ph = lambda v: re.sub(r"\D", "", str(v or ""))[-10:] if len(re.sub(r"\D", "", str(v or ""))) >= 10 else None
nm = lambda v: " ".join(w for w in re.sub(r"[^a-z ]", " ", str(v or "").lower()).split() if w not in ("mr", "mrs", "ms", "dr", "miss"))
VOWISH = re.compile(r"home|visit|mobile|vow|review|nobivac|travel|transport", re.I)

with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as c, c.cursor() as cur:
    cur.execute("""select invoice_no, is_vow, doctor, item_name, coalesce(net_sales,0), coalesce(return_net,0),
                          coalesce(final_sales,0), coalesce(return_total,0), amount, client_name, client_phone, sales_unit, sale_datetime
                     from vetbuddy.sales where sale_date = %s and clinic_unit = %s order by invoice_no""", (day, cu))
    vb = cur.fetchall()
    cur.execute("select max(sale_date), count(*) from vetbuddy.sales where sale_date = %s", (day,))
    print("VetBuddy rows that day (all clinics):", cur.fetchone())

inv = collections.OrderedDict()
for no, isv, doc, item, net, rnet, fin, rtot, amt, cname, cph, su, sdt in vb:
    e = inv.setdefault(no, {"vow": isv, "doc": doc, "net": 0, "ret": 0, "fin": 0, "rtot": 0, "items": [], "name": nm(cname), "ph": ph(cph), "su": set()})
    e["net"] += float(net); e["ret"] += float(rnet); e["fin"] += float(fin); e["rtot"] += float(rtot); e["items"].append(item); e["su"].add(su)
vow_docs = {e["doc"] for e in inv.values() if e["vow"]}
print(f"\n=== VetBuddy {clinic} {day}: {len(inv)} invoices; VoW doctors: {sorted(vow_docs)}")
T = collections.Counter()
for no, e in inv.items():
    k = "VOW" if e["vow"] else "clinic"
    T[k + " net"] += e["net"] - e["ret"]; T[k + " with tax"] += e["fin"] - e["rtot"]
    if e["vow"] or e["doc"] in vow_docs or any(VOWISH.search(str(i or "")) for i in e["items"]) or e["ret"]:
        flag = "" if e["vow"] else "  <-- CLINIC invoice: " + ("VoW doctor " if e["doc"] in vow_docs else "") + ("VoW-like item " if any(VOWISH.search(str(i or "")) for i in e["items"]) else "") + ("return" if e["ret"] else "")
        print(f"  {no:8} {'VoW ' if e['vow'] else 'clin'} {str(e['doc'])[:24]:24} net {e['net']-e['ret']:>9,.2f}  with tax {e['fin']-e['rtot']:>9,.2f}  units {sorted(e['su'])}{flag}")
        if not e["vow"]:
            print("           items:", "; ".join(sorted({str(i)[:40] for i in e["items"]})))
for k in sorted(T):
    print(f"  TOTAL {k:16} {T[k]:>12,.2f}")

gs = gofrugal.Session(); gs.login()
s_rows = [r for r in gofrugal.parse_csv(gs.export_csv(gofrugal.SALES_REPORT, day, day)) if vow.units_for_clinic(r.get("Outlet Name"))[0] == cu]
r_rows = [r for r in gofrugal.parse_csv(gs.export_csv(gofrugal.RETURNS_REPORT, day, day)) if vow.units_for_clinic(r.get("Outlet Name"))[0] == cu]
vow_keys = {("n", e["name"]) for e in inv.values() if e["vow"] and e["name"]} | {("p", e["ph"]) for e in inv.values() if e["vow"] and e["ph"]}
bills = collections.OrderedDict()
for r in s_rows:
    b = bills.setdefault(r.get("Bill No"), {"doc": (r.get("Doctor Name") or r.get("Doc Name(During Billing)") or "").strip(), "bt": 0, "net": 0, "keys": set()})
    b["bt"] += gofrugal._num(r.get("Item Amt BeforeTax")); b["net"] += gofrugal._num(r.get("Item Net Amt"))
    for pc in ("Telephone", "Phone1", "Mobile No/SMS Alerts", "Mobile2"):
        if ph(r.get(pc)): b["keys"].add(("p", ph(r.get(pc))))
    for ncol in ("Cust Name(During Billing)", "Cust. Name"):
        if nm(r.get(ncol)): b["keys"].add(("n", nm(r.get(ncol))))
print(f"\n=== Gofrugal {clinic} {day}: {len(bills)} sale bills, {len(r_rows)} return lines")
G = collections.Counter()
for no, b in bills.items():
    isv = vow.doctor_matches(b["doc"], vow_docs)
    k = "VOW" if isv else "clinic"
    G[k + " before tax"] += b["bt"]; G[k + " with tax"] += b["net"]
    cust_vow = bool(b["keys"] & vow_keys)
    if isv or cust_vow:
        flag = "" if isv else "  <-- NOT counted as VoW, but the customer has a VoW invoice today"
        print(f"  {no:8} {'VoW ' if isv else 'clin'} {b['doc'][:26]:26} before tax {b['bt']:>9,.2f}  with tax {b['net']:>9,.2f}{flag}")
for r in r_rows:
    isv = vow.doctor_matches((r.get("Doctor Name") or "").strip(), vow_docs)
    G[("VOW" if isv else "clinic") + " returns before tax"] -= gofrugal._num(r.get("Sub Total"))
    if isv:
        print(f"  RETURN {r.get('Prefix_Ret.No') or r.get('Ret. No.')} {r.get('Doctor Name')} {gofrugal._num(r.get('Sub Total')):,.2f}")
for k in sorted(G):
    print(f"  TOTAL {k:26} {G[k]:>12,.2f}")
print(f"\n=== {vu} {day}: VetBuddy net {T['VOW net']:,.2f} + Gofrugal before tax {G['VOW before tax'] + G['VOW returns before tax']:,.2f}"
      f" = {T['VOW net'] + G['VOW before tax'] + G['VOW returns before tax']:,.2f}")
print(f"    with tax: VetBuddy {T['VOW with tax']:,.2f} + Gofrugal {G['VOW with tax']:,.2f} = {T['VOW with tax'] + G['VOW with tax']:,.2f}")
