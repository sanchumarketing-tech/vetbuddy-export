#!/usr/bin/env python3
"""Dry run: build a day's Call Desk list inside a transaction, print what it would contain, then roll back.
Nothing is changed. Usage: python tools/calldesk_dry_run.py [YYYY-MM-DD]   (default: tomorrow)"""
import datetime as dt, json, os, sys
import psycopg

day = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else (dt.date.today() + dt.timedelta(days=1)).isoformat()
with psycopg.connect(os.environ["SUPABASE_DB_URL"], options="-c statement_timeout=0") as c, c.cursor() as cur:
    cur.execute("set local statement_timeout = '15min'")
    cur.execute("select calldesk.build_list(%s::date, true)", (day,))
    res = cur.fetchone()[0]
    print("Dry run for", day)
    print(json.dumps(res, indent=1))
    cur.execute("""select e->>'label' from calldesk.queue q, jsonb_array_elements(q.reasons) e
                    where q.list_date = %s::date and e->>'type' = 'followup' order by random() limit 5""", (day,))
    for (l,) in cur.fetchall():
        print("  follow-up:", l)
    try:
        cur.execute("select why, count(*) from calldesk.followups where due <= %s::date group by 1", (day,))
        print("follow-ups due and not placed:", cur.fetchall())
    except Exception as e:  # noqa: BLE001
        print("(follow-up count not readable:", type(e).__name__, ")")
    try:   # deceased pets (23 Nov 2026): all must be 0
        cur.execute("""select
            (select count(*) from calldesk.queue q where q.list_date = %s::date
                and exists (select 1 from calldesk.deceased_map m where m.phone = q.phone and m.all_dead)) all_deceased_numbers,
            (select count(*) from calldesk.queue q where q.list_date = %s::date
                and q.reasons <> calldesk.deceased_strip(q.phone, q.reasons)) rows_with_deceased_reason,
            (select count(*) from calldesk.queue q, jsonb_array_elements(q.pets) e where q.list_date = %s::date
                and exists (select 1 from calldesk.deceased_pets x where x.pet_id = e->>'pet_id')) deceased_pet_cards""", (day, day, day))
        print("deceased check (all must be 0):", cur.fetchone())
    except Exception as e:  # noqa: BLE001
        print("(deceased check not readable:", type(e).__name__, e, ")")
    c.rollback()
    print("Rolled back - nothing changed.")
