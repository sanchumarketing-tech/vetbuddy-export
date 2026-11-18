#!/usr/bin/env python3
"""Read-only: VetBuddy appointments per day and unit (all statuses / completed / no show), Vet on Wheels apart.
Pulls the Appointment Status report from VetBuddy for each day FROM..TO and prints only counts (CSV), no customer data.
Usage: python tools/appt_daily_counts.py 2026-09-01 2026-11-17"""
import datetime as dt
import sys
from collections import Counter
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vetbuddy_sales_export as vb               # noqa: E402  login, retry
import vetbuddy_appointments_export as ap        # noqa: E402  report download / parse
import reminder_calls_check as rc                # noqa: E402  short_clinic

first, last = (dt.date.fromisoformat(x) for x in sys.argv[1:3])
s = requests.Session()
s.headers["User-Agent"] = "Mozilla/5.0 (VetBuddy counts)"
vb.login(s)
col = {c.lower(): i for i, c in enumerate(ap.EXPORT_COLUMNS)}
g = lambda row, name: row[col[name.lower()]]   # noqa: E731
cnt, types, statuses, other = Counter(), Counter(), Counter(), Counter()
day = first
while day <= last:
    got = {}
    def fetch(day=day):
        got["rows"] = ap.parse_xls(ap.download_xls(s, day))
    if not vb.retry(f"Appointments {day}", fetch, 3, 45):
        print(f"MISSING,{day}", flush=True)
        day += dt.timedelta(days=1)
        continue
    seen = set()
    for row in got["rows"]:
        aid = str(g(row, "Appointment ID") or "").strip()
        if not aid or aid in seen:
            continue
        seen.add(aid)
        d = ap.appt_date(g(row, "Appointment Time")) or day
        unit = rc.short_clinic(str(g(row, "Clinic") or "")) or "Unknown"
        typ = str(g(row, "Appointment Type") or "").strip()
        st = str(g(row, "Status") or "").strip().lower()
        kind = "Vet on Wheels" if typ.lower() == "doctor on wheels" else "Clinic"
        types[typ] += 1
        if not (st.startswith("check out") or st.startswith("no show") or st.startswith("cancel")):
            other[(d.isoformat(), kind, unit, st)] += 1
        statuses[st] += 1
        for k in ("appointments",) + (("completed",) if st.startswith("check out") else ()) + (("no_show",) if st.startswith("no show") else ()) + (("cancelled",) if st.startswith("cancel") else ()):
            cnt[(d.isoformat(), kind, unit, k)] += 1
    day += dt.timedelta(days=1)
print("TYPES", dict(types.most_common()))
print("STATUSES", dict(statuses.most_common()))
print("CSV_START")
print("date,kind,unit,appointments,completed,no_show,cancelled")
keys = sorted({k[:3] for k in cnt})
for k in keys:
    print(f"{k[0]},{k[1]},{k[2]},{cnt[k + ('appointments',)]},{cnt[k + ('completed',)]},{cnt[k + ('no_show',)]},{cnt[k + ('cancelled',)]}")
print("CSV_END")
print("OTHER_START")
for k, v in sorted(other.items()):
    print(f"{k[0]},{k[1]},{k[2]},{k[3]},{v}")
print("OTHER_END")
