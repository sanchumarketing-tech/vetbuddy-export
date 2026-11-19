#!/usr/bin/env python3
"""One-off (VoW attribution, 18 Nov 2026): for the phone numbers in calldesk.vow_attr_phones, copy their
Corefactor calls, Runo calls and Lead Box entries between FROM and TO into calldesk.vow_touch.
Only those numbers are kept; nothing else is written. Usage: python tools/vow_touch_load.py 2026-09-01 2026-11-03"""
import datetime as dt, logging, os, sys
from collections import Counter
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import calldesk_load as cl  # noqa: E402

first, last = (dt.date.fromisoformat(x) for x in sys.argv[1:3])
log = cl.log
logging.basicConfig(level=logging.INFO, format='%(asctime)s  %(levelname)s  %(message)s')
with cl.vetbuddy_sql.connect() as conn, conn.cursor() as cur:
    cur.execute("set statement_timeout = '15min'")
    cur.execute("select phone from calldesk.vow_attr_phones")
    phones = {r[0] for r in cur.fetchall()}
    log.info("%d numbers to look for", len(phones))
    cur.execute("delete from calldesk.vow_touch")
    # 19 Nov 2026: also keep every Vet on Wheels lead (and every lead of these numbers) with its Lead Box fields,
    # for the "why came / why not booked / booked but no VetBuddy appointment" analysis
    # table calldesk.vow_leads (created_at timestamp, phone text, vow_lead boolean, d jsonb) is created by an admin
    cur.execute("delete from calldesk.vow_leads")
    LEAD_FROM = dt.date.fromisoformat(os.environ.get("VOW_LEADS_FROM") or "2026-10-12")
    leads_out = []
    seen, recs = Counter(), []

    def master_rows(site_var, lib_var, path_var, default_path):
        """Rows of a SharePoint master workbook (every sheet with a header row) as dicts."""
        import io, openpyxl
        sp = cl.cf.SharePoint.from_env(site_var, lib_var)
        data, _ = sp.download(os.environ.get(path_var) or default_path)
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        for ws in wb.worksheets:
            it = ws.iter_rows(values_only=True)
            head = None
            for vals in it:
                if head is None:
                    if vals and sum(1 for v in vals if v not in (None, "")) >= 3:
                        head = [str(v or "").strip() for v in vals]
                    continue
                yield ws.title, dict(zip(head, vals))

    pick, nph = cl.rc.pick, cl.norm_phone
    lo, hi = dt.datetime.combine(first, dt.time()), dt.datetime.combine(last, dt.time(23, 59, 59))
    def when(r, *names):
        for n in names:
            v = pick(r, n)
            t = v if isinstance(v, dt.datetime) else cl.cf.parse_dt(v)
            if t:
                return t
        return None

    n = Counter()
    try:
        for sheet, r in master_rows("SP_CALLLOG_SITE_URL", "SP_CALLLOG_LIBRARY", "SP_CALLLOG_MASTER_PATH",
                                    "Sanchu Reports/Backend Call Log Report.xlsx"):
            n["cf rows"] += 1
            ph = nph(pick(r, "Customer Number", "Phone", "Caller Number"))
            if ph not in phones:
                continue
            t = when(r, "Start Time", "Call Date", "Date")
            if not t or not lo <= t <= hi:
                continue
            talk = cl.seconds(pick(r, "Talk Time"))
            recs.append(("Corefactor", t, ph, str(pick(r, "Call Type") or ""), str(pick(r, "Call Status") or ""),
                         (talk or 0) >= 15, talk, str(pick(r, "Agent Name") or ""),
                         " | ".join(str(x) for x in (pick(r, "Disposition"), pick(r, "Campaign Name", "Campaign"), pick(r, "Notes", "Remarks")) if x)[:200]))
            n["Corefactor"] += 1
    except Exception as e:  # noqa: BLE001
        log.error("Corefactor master not read: %s", e)
    try:
        for r in cl.runo_rows(first, last, seen):
            if r[3] in phones:
                recs.append(("Runo", r[2], r[3], r[4], r[6], r[7], r[8], r[9], r[13]))
                n["Runo"] += 1
    except Exception as e:  # noqa: BLE001
        log.error("Runo not read: %s", e)
    try:
        for sheet, r in master_rows("SP_LEADBOX_SITE_URL", "SP_LEADBOX_LIBRARY", "SP_LEADBOX_MASTER_PATH",
                                    "Sanchu Reports/Backend Leadbox Report.xlsx"):
            n["lead rows"] += 1
            if n["lead rows"] == 1:
                log.info("Lead Box columns: %s", ", ".join(k for k in r if k))
            ph = nph(pick(r, "Phone", "Mobile", "Phone Number", "Mobile Number", "Contact Number", "Customer Number", "Lead Number"))
            t = when(r, "Created Date", "Created On", "Created At", "Date")
            if not t or not lo <= t <= hi:
                continue
            blob = " ".join(str(r.get(k) or "") for k in ("Purpose of Calling", "Purpose Of Calling", "Appointment Type", "Campaign_Name",
                                                           "AdSet_Name", "Ad_Name", "Form_Name", "Lead Source Campaign")).lower()
            is_vow = "wheel" in blob or "vow" in blob
            if (is_vow and t.date() >= LEAD_FROM) or ph in phones:
                d = {}
                for k, v in r.items():
                    if not k or v in (None, "") or k.startswith("Location") or k in ("Email", "Alternate Mobile Number"):
                        continue
                    d[k] = v.isoformat() if isinstance(v, (dt.datetime, dt.date)) else (str(v).strip()[:300] if isinstance(v, str) else v)
                if d:
                    import json as _j
                    leads_out.append((t, ph, is_vow, _j.dumps(d, default=str)))
                    n["vow leads kept"] += 1
            if ph not in phones:
                continue
            recs.append(("Lead Box", t, ph, "lead", str(pick(r, "Status", "Lead Status", "Stage") or ""), None, None,
                         str(pick(r, "Lead Owner", "Owner", "Assigned To") or ""),
                         " | ".join(str(x) for x in (pick(r, "Lead Source", "Source"), pick(r, "Purpose Of Calling", "Purpose of Calling", "Purpose"),
                                                     pick(r, "Comments", "Remarks")) if x)[:200]))
            n["Lead Box"] += 1
    except Exception as e:  # noqa: BLE001
        log.error("Lead Box master not read: %s", e)
    cur.executemany("insert into calldesk.vow_touch (source, ts, phone, direction, status, answered, talk_s, agent, detail) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s, %s)", recs)
    cur.executemany("insert into calldesk.vow_leads (created_at, phone, vow_lead, d) values (%s, %s, %s, %s::jsonb)", leads_out)
    log.info("Saved %d touches and %d leads: %s", len(recs), len(leads_out), dict(n))
