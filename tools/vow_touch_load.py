#!/usr/bin/env python3
"""One-off (VoW attribution, 18 Nov 2026): for the phone numbers in calldesk.vow_attr_phones, copy their
Corefactor calls, Runo calls and Lead Box entries between FROM and TO into calldesk.vow_touch.
Only those numbers are kept; nothing else is written. Usage: python tools/vow_touch_load.py 2026-09-01 2026-11-03"""
import datetime as dt, sys
from collections import Counter
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import calldesk_load as cl  # noqa: E402

first, last = (dt.date.fromisoformat(x) for x in sys.argv[1:3])
log = cl.log
with cl.vetbuddy_sql.connect() as conn, conn.cursor() as cur:
    cur.execute("set statement_timeout = '15min'")
    cur.execute("select phone from calldesk.vow_attr_phones")
    phones = {r[0] for r in cur.fetchall()}
    log.info("%d numbers to look for", len(phones))
    cur.execute("delete from calldesk.vow_touch")
    seen, recs = Counter(), []
    try:
        for r in cl.corefactor_rows(cl.cf.SharePoint.from_env(), first, last, seen):
            if r[3] in phones:   # (source, key, when, phone, direction, kind, status, answered, dur, agent, name, line, dtmf, notes, disp, campaign, talk, rec)
                recs.append(("Corefactor", r[2], r[3], r[4], r[6], r[7], r[16] if r[16] is not None else r[8], r[9], r[15] or r[14] or r[13]))
    except Exception as e:  # noqa: BLE001
        log.error("Corefactor not read: %s", e)
    n_cf = len(recs)
    try:
        for r in cl.runo_rows(first, last, seen):
            if r[3] in phones:
                recs.append(("Runo", r[2], r[3], r[4], r[6], r[7], r[8], r[9], r[13]))
    except Exception as e:  # noqa: BLE001
        log.error("Runo not read: %s", e)
    n_runo = len(recs) - n_cf
    sp = cl.cf.SharePoint.from_env()
    d, n_lead, missing = first, 0, 0
    while d <= last:
        for ext in (".csv", ".xlsx", ".xls"):
            name = f"Corefactor_LeadBox_{d.isoformat()}{ext}"
            try:
                data, _ = sp.download(f"{cl.LEADBOX_FOLDER.strip('/')}/{name}")
            except Exception:  # noqa: BLE001
                continue
            for r in cl.rc.read_table(name, data):
                ph = cl.norm_phone(cl.rc.pick(r, "Phone", "Mobile", "Phone Number", "Mobile Number", "Contact Number",
                                              "Customer Number", "Lead Number"))
                if ph not in phones:
                    continue
                created = cl.cf.parse_dt(cl.rc.pick(r, "Created Date", "Created On", "Created At", "Date")) or \
                    dt.datetime.combine(d, dt.time(12))
                recs.append(("Lead Box", created, ph, "lead", str(cl.rc.pick(r, "Sub Status", "Status") or ""), None, None,
                             str(cl.rc.pick(r, "Lead Owner", "Owner") or ""),
                             " | ".join(str(x) for x in (cl.rc.pick(r, "Lead Source", "Source"), cl.rc.pick(r, "Purpose of Calling", "Purpose Of Calling"),
                                                         cl.rc.pick(r, "Comments")) if x)[:200]))
                n_lead += 1
            break
        else:
            missing += 1
        d += dt.timedelta(days=1)
    cur.executemany("insert into calldesk.vow_touch (source, ts, phone, direction, status, answered, talk_s, agent, detail) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s, %s)", recs)
    log.info("Saved: Corefactor %d, Runo %d, Lead Box %d (Lead Box files missing for %d days)", n_cf, n_runo, n_lead, missing)
