#!/usr/bin/env python3
"""Write the live definitions of the Call Desk database functions to sql/live/<schema>.<name>.sql
(the database is the source of truth; this keeps the repo in step). Changes nothing in the database."""
import os, pathlib, psycopg
out = pathlib.Path("sql/live"); out.mkdir(parents=True, exist_ok=True)
with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as c, c.cursor() as cur:
    cur.execute("""select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'calldesk' or (n.nspname = 'public' and p.proname like 'cd\\_%')
                    order by 1, 2""")
    for sch, name, args, body in cur.fetchall():
        f = out / f"{sch}.{name}.sql"
        f.write_text(f"-- live definition of {sch}.{name}({args}) - exported from the database\n{body};\n")
        print("wrote", f)
