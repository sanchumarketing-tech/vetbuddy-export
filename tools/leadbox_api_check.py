#!/usr/bin/env python3
"""Read-only check of Corefactor's Lead Box API (18 Nov 2026). Changes nothing.
Fetches the leads created on one day, then prints only the field names, how many leads have each field filled,
and how the fields match the headers of Backend Leadbox Report.xlsx. No customer data is printed.
Env: COREFACTOR_LEADBOX_API_KEY, SP_* (to read the master's header row)."""
import io, os, sys, time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import corefactor_calllogs_export as cf  # noqa: E402

KEY = os.environ["COREFACTOR_LEADBOX_API_KEY"].strip()
day = sys.argv[1] if len(sys.argv) > 1 else (datetime.now(cf.IST).date() - timedelta(days=1)).isoformat()
hosts = ["https://tw1.teleduce.corefactors.in", "https://teleduce.corefactors.in"]
leads, used = [], None
for host in hosts:
    leads, page = [], 1
    while True:
        r = requests.get(f"{host}/lead/retrieval/", headers={"API-KEY": KEY, "Content-Type": "application/json"},
                         params={"created_at_range": f"{day},{day}", "page": page, "record_size": 100}, timeout=120)
        print(f"{host} page {page}: HTTP {r.status_code}, {r.headers.get('content-type')}")
        try:
            j = r.json()
        except ValueError:
            print("  not JSON:", r.text[:200].replace(KEY, "***")); break
        code = str(j.get("response_code"))
        if code != "7000":
            print("  response_code", code, "-", str(j.get("reponse") or j.get("response"))[:200]); break
        batch = j.get("response") or []
        leads += batch
        print(f"  {len(batch)} leads, more: {j.get('is_more_leads_available')}")
        if not j.get("is_more_leads_available") or not batch:
            break
        page += 1
        time.sleep(0.5)
    if leads:
        used = host
        break
print(f"\nLeads created on {day}: {len(leads)} (from {used})")
if not leads:
    sys.exit(0)
filled = Counter(k for l in leads for k, v in l.items() if v not in (None, "", []))
keys = sorted({k for l in leads for k in l})
print(f"\nAPI fields ({len(keys)}), with how many leads have a value:")
for k in keys:
    v = next((l[k] for l in leads if l.get(k) not in (None, "")), None)
    print(f"  {k!r:40} {filled[k]:5}   type={type(v).__name__}" + (f" e.g. {v!r}" if k.lower() in ("created_at", "modified_at", "lead status", "leads stages", "lead source", "lead type") else ""))

sp = cf.SharePoint.from_env("SP_LEADBOX_SITE_URL", "SP_LEADBOX_LIBRARY")
data, _ = sp.download(os.environ.get("SP_LEADBOX_MASTER_PATH") or "Sanchu Reports/Backend Leadbox Report.xlsx")
from openpyxl import load_workbook
ws = load_workbook(io.BytesIO(data), read_only=True).worksheets[0]
head = [str(c).strip() for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True)) if c not in (None, "")]
api = {cf.norm(k): k for k in keys}
print(f"\nMaster columns ({len(head)}): matched to an API field?")
for h in head:
    print(f"  {h!r:40} -> {api.get(cf.norm(h), '-')!r}")
print("\nAPI fields not in the master:", [k for k in keys if cf.norm(k) not in {cf.norm(h) for h in head}])
