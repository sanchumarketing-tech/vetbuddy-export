#!/usr/bin/env python3
"""Read only: the Vetbuddy invoices behind a Vet on Wheels figure (clinical + non clinical) for one day.
No client names or phone numbers are printed. Env: SUPABASE_DB_URL, DAY (YYYY-MM-DD), UNIT (e.g. CBE VET ON WHEELS)."""
import os, psycopg
day, unit = os.environ["DAY"], os.environ.get("UNIT") or "CBE VET ON WHEELS"
with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as c, c.cursor() as cur:
    cur.execute("""select sales_unit, invoice_no, doctor, item_name, coalesce(net_sales,0) - coalesce(return_net,0), amount
                     from vetbuddy.sales where sale_date = %s and sales_unit like %s
                    order by sales_unit, invoice_no, item_name""", (day, unit + "%"))
    rows = cur.fetchall()
tot = {}
inv = {}
for su, no, doc, item, net, amt in rows:
    print(f"{su:35} {no:10} {str(doc)[:28]:28} {str(item)[:45]:45} {float(amt or 0):>10,.2f}")
    tot[su] = tot.get(su, 0) + float(amt or 0)
    inv.setdefault(su, {}).setdefault(no, 0)
    inv[su][no] += float(amt or 0)
print()
for su in inv:
    print(f"== {su}: {len(inv[su])} invoices, total {tot[su]:,.2f}")
    for no, a in inv[su].items():
        print(f"   {no}  {a:,.2f}")
