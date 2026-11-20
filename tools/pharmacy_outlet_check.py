#!/usr/bin/env python3
"""Read-only (20 Nov 2026): pharmacy sales per Gofrugal outlet per day, from vetbuddy.pharmacy_sales.
Answers "does this outlet ever bill?" before an outlet that is behind in the data sync is skipped.
Prints counts and amounts only (no customer data)."""
import os
import psycopg

days = int(os.environ.get("DAYS") or 45)
with psycopg.connect(os.environ["SUPABASE_DB_URL"], connect_timeout=60) as con, con.cursor() as cur:
    cur.execute("""select outlet, count(*) lines, count(distinct bill_no) bills, round(sum(net_amount)) amount,
                          min(sale_date), max(sale_date), count(distinct sale_date) days_with_sales
                   from vetbuddy.pharmacy_sales where sale_date >= current_date - %s and kind ilike 'sale%%'
                   group by 1 order by 1""", (days,))
    print("outlet,lines,bills,amount,first_day,last_day,days_with_sales")
    for r in cur.fetchall():
        print(",".join(str(x) for x in r))
    cur.execute("""select outlet, sale_date, count(distinct bill_no), round(sum(net_amount)) from vetbuddy.pharmacy_sales
                   where sale_date >= current_date - 10 and (outlet ilike '%%warehouse%%' or outlet ilike '%%anna nagar 5%%' or outlet ilike '%%anna nagar%%')
                   group by 1, 2 order by 1, 2""")
    print("\noutlet,date,bills,amount (last 10 days, Warehouse / Anna Nagar outlets)")
    for r in cur.fetchall():
        print(",".join(str(x) for x in r))
    cur.execute("select kind, count(*) from vetbuddy.pharmacy_sales where sale_date >= current_date - %s group by 1", (days,))
    print("\nkinds:", cur.fetchall())
