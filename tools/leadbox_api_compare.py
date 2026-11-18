#!/usr/bin/env python3
"""Read-only: which leads of one day are in the old export (calldesk.leads, raw 'Unique ID') but not in the
Lead API, and the other way round. Prints only counts and non-personal fields (times, source, status, owner)."""
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import corefactor_calllogs_export as cf  # noqa: E402
import corefactor_leadbox_api as la  # noqa: E402
import vetbuddy_sql as vs  # noqa: E402

cf.setup_logging()
day = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
# everything the API has over a wide range, by ID
import requests, time
base = cf.env("COREFACTOR_BASE_URL", "https://tw1.teleduce.corefactors.in")
key = cf.env("COREFACTOR_LEADBOX_API_KEY", required=True).strip()
api, page = {}, 1
while True:
    j = requests.get(f"{base}/lead/retrieval/", headers={"API-KEY": key, "Content-Type": "application/json"},
                     json={"created_at_range": f"{day - timedelta(days=3)},{day + timedelta(days=3)}", "page": page, "record_size": 100}, timeout=120).json()
    if str(j.get("response_code")) != "7000":
        break
    for l in j.get("response") or []:
        api[str(l.get("ID"))] = l
    if not j.get("is_more_leads_available"):
        break
    page += 1
print("API leads over +-3 days:", len(api), "pages", page)
with vs.connect() as c, c.cursor() as cur:
    cur.execute("select raw from calldesk.leads where created_at::date = %s and lead_key not like 'live:%%'", (day,))
    old = {str(r[0].get("Unique ID")): r[0] for (r) in cur.fetchall()}
print("Old export leads for the day:", len(old))
missing = [old[k] for k in old if k not in api]
print("In old export, not in API at all:", len(missing))
for f in ("Lead Source", "Lead Status", "Lead Owner", "Call Status", "Lead type", "Type Of Customer", "Parent/Clone", "Lead Assigned By"):
    print(f"  by {f}:", Counter(str(m.get(f)) for m in missing).most_common(8))
print("  created hours:", sorted(Counter(str(m.get("Created Date"))[11:13] or str(m.get("Created Date")) for m in missing).items())[:30])
print("  sample created values:", [str(m.get("Created Date")) for m in missing[:5]])
inapi_otherday = [api[k] for k in old if k in api and str(api[k].get("created_at"))[:10] != day.isoformat()]
print("In both, but API created_at is another day:", len(inapi_otherday), Counter(str(a.get("created_at"))[:13] for a in inapi_otherday).most_common(10))
for k in list(old)[:3]:
    if k in api:
        print("  example created: old", old[k].get("Created Date"), "| api", api[k].get("created_at"))
extra = [a for k, a in api.items() if str(a.get("created_at"))[:10] == day.isoformat() and k not in old]
print("In API for the day, not in old export:", len(extra))
