#!/usr/bin/env python3
"""
Call Desk daily load -> Supabase (calldesk schema) -> today's call lists.

Since 16 Nov 2026 each source job writes its own data into the database as its last step
(Corefactor 06:53 -> calls, Lead Box 07:03 -> leads, Runo 07:13 -> calls, appointments 07:23 + 01:01 PM,
reminders 07:47) by running this script with --only <step> --no-build; the 08:05 Call Desk job runs
only "--only build" and reads nothing but the database. The steps:
  1. Call logs   Corefactor daily files in "Call Log Archive" (last few days) and the Runo master
                 "Runo CallLog.xlsx" -> calldesk.calls. Re-loading a day is harmless (rows are keyed).
  2. Reminders   VetBuddy Reminders Management, due yesterday .. +3 days -> calldesk.reminders
  3. Appointments VetBuddy Appointment Status for 2 days back .. 14 days ahead -> calldesk.appointments
  4. Leads       Corefactor Lead Box daily files in "Lead Box Archive" (last 3 days) -> calldesk.leads
  5. Builds today's lists: select calldesk.build_list(today)   (see sql/17_calldesk.sql)

It only READS VetBuddy and the SharePoint files the other jobs write; it changes nothing of theirs.
A source that fails is logged and skipped - the list is still built from the rest.

Usage:
  python calldesk_load.py                          today
  python calldesk_load.py --day 2026-11-13 --rebuild   rebuild a day's list (rows nobody touched yet)
  python calldesk_load.py --only calls --days 10       load just the call logs of the last 10 days
Environment: the same secrets as reminder_calls_check.py (VETBUDDY_*, SUPABASE_DB_URL, SP_*).
"""

import argparse
import datetime as dt
import hashlib
import io
import json
import logging
import re
import sys
from collections import Counter
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import vetbuddy_sales_export as vb               # noqa: E402  VetBuddy login, IST, logging
import corefactor_calllogs_export as cf          # noqa: E402  SharePoint helper, date parsing
import reminder_calls_check as rc                # noqa: E402  reminder export + parsing, phone helpers
import vetbuddy_appointments_export as ap        # noqa: E402  appointment report download + parsing
import vetbuddy_sql                              # noqa: E402  Supabase connection

log = logging.getLogger("vetbuddy")
IST = vb.IST
env = rc.env
norm_phone = rc.norm_phone
LEADBOX_FOLDER = env("SP_LEADBOX_ARCHIVE_FOLDER", "Lead Box Archive")


def key(*parts):
    return hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()


def seconds(v):
    """'00:01:23' / '1:23' / 83 / '83' -> 83."""
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return int(v) if v < 86400 else None
    s = str(v).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return int(float(s))
    m = re.fullmatch(r"(?:(\d+):)?(\d+):(\d+)", s)
    if m:
        return int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return None


def direction(kind, status=""):
    k = f"{kind or ''} {status or ''}".lower()
    if re.search(r"incoming|inbound|missed|\bin\b|\bib\b|ivr", k):
        return "in"
    if re.search(r"outgoing|outbound|click|manual|dial|progressive|preview|\bout\b|\bob\b", k):
        return "out"
    return "?"


def answered(status, dur):
    """A real conversation: answered and at least 15 seconds (a 6-second 'answered' is a hang-up)."""
    if dur is not None and dur < 15:
        return False
    r = str(status or "").lower()
    if re.search(r"not.?answer|unanswer|no.?answer|missed|busy|fail|cancel|reject|abandon|not.?connect", r):
        return False
    if re.search(r"answer|connected|completed|success", r):
        return True
    return bool(dur and dur >= 10)


# ----------------------------------------------------------------------------- 1. call logs
def corefactor_rows(sp, first, last, seen):
    out = []
    d = first
    while d <= last:
        for ext in (".csv", ".xlsx", ".xls"):
            name = f"Corefactor_CallLogs_{d.isoformat()}{ext}"
            try:
                data, _ = sp.download(f"{rc.ARCHIVE_FOLDER.strip('/')}/{name}")
            except Exception:  # noqa: BLE001  not there with this extension
                continue
            n = 0
            table = rc.read_table(name, data)
            if table and d == last:
                log.info("Corefactor columns: %s", ", ".join(table[0].keys()))
            for r in table:
                ph = norm_phone(rc.pick(r, "Customer Number", "Phone", "Caller Number"))
                when = cf.parse_dt(rc.pick(r, "Start Time", "Call Date")) or cf.parse_dt(rc.pick(r, "Call Date"))
                if not ph or not when:
                    continue
                kind = str(rc.pick(r, "Call Type") or "")
                status = str(rc.pick(r, "Call Status") or "")
                dur = seconds(rc.pick(r, "Total Time", "Duration", "Talk Time"))
                talk = seconds(rc.pick(r, "Talk Time"))          # the conversation itself (Total Time includes ringing)
                agent = str(rc.pick(r, "Agent Name") or "")
                seen[("Corefactor", kind, status)] += 1
                txt = lambda *names: (str(rc.pick(r, *names) or "").strip()[:200] or None)   # noqa: E731
                line = txt("DID Number", "DID", "Virtual Number", "Did Number")
                if line and re.fullmatch(r"\d+\.0", line):
                    line = line[:-2]
                out.append(("Corefactor", key(when, ph, kind, status, agent, dur), when, ph, direction(kind, status),
                            kind, status, answered(status, talk if talk is not None else dur), dur, agent,
                            txt("Customer Name"), line, txt("DTMF", "IVR Input", "Dtmf"), txt("Notes", "Remarks"),
                            txt("Call Disposition", "Disposition"), txt("Campaign Name", "Campaign"), talk,
                            txt("Recording", "Recording URL")))
                n += 1
            log.info("Corefactor %s: %d calls", d, n)
            break
        else:
            log.warning("No Corefactor call-log file for %s", d)
        d += dt.timedelta(days=1)
    return out


def runo_rows(first, last, seen):
    path = env("SP_RUNO_MASTER_PATH", "Sanchu Reports/Runo CallLog.xlsx")
    sp = cf.SharePoint.from_env("SP_RUNO_SITE_URL", "SP_RUNO_LIBRARY")
    data, _ = sp.download(path)
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    it = wb.worksheets[0].iter_rows(values_only=True)
    hdr = [cf.norm(h) for h in next(it)]
    want = ("phone", "callstartdate", "calltype", "calltag", "status", "callername", "duration", "callduration",
            "callid", "id", "name", "notes")
    ix = {n: hdr.index(n) for n in want if n in hdr}
    if "phone" not in ix or "callstartdate" not in ix:
        raise RuntimeError(f"Runo call log: 'Phone' / 'Call Start Date' not found in {hdr[:20]}")
    out = []
    for r in it:
        when = r[ix["callstartdate"]]
        when = cf.parse_dt(when) if not isinstance(when, (int, float)) else (
            dt.datetime(1899, 12, 30) + dt.timedelta(days=float(when)) if 20000 < when < 80000 else None)
        if not when or not (first <= when.date() <= last):
            continue
        ph = norm_phone(r[ix["phone"]])
        if not ph:
            continue
        g = lambda k: (r[ix[k]] if k in ix else "") or ""   # noqa: E731
        kind, tag, status = str(g("calltype")), str(g("calltag")), str(g("status"))
        dur = seconds(g("duration") or g("callduration"))
        agent = str(g("callername"))
        seen[("Runo", kind, tag or status)] += 1
        out.append(("Runo", str(g("callid") or g("id") or key(when, ph, kind, agent, dur)), when, ph,
                    direction(kind, tag), kind, tag or status, answered(tag or status, dur), dur, agent,
                    str(g("name") or "")[:120] or None, agent or None, None, str(g("notes") or "")[:200] or None,
                    tag or None, None, None, None))
    log.info("Runo %s .. %s: %d calls", first, last, len(out))
    return out


def load_calls(cur, today, days, source=None):
    first, last = today - dt.timedelta(days=days), today - dt.timedelta(days=1)
    seen, rows = Counter(), []
    if source in (None, "corefactor"):
        try:
            rows += corefactor_rows(cf.SharePoint.from_env(), first, last, seen)
        except Exception as e:  # noqa: BLE001
            log.error("Corefactor call logs not loaded: %s", e)
    if source in (None, "runo"):
        try:
            rows += runo_rows(first, last, seen)
        except Exception as e:  # noqa: BLE001
            log.error("Runo call logs not loaded: %s", e)
    for (src, kind, status), n in seen.most_common(25):
        log.info("  %-10s type=%-22s status=%-28s %6d -> %s", src, kind[:22], status[:28], n, direction(kind, status))
    if not rows:
        return 0
    cur.execute("create temp table t_calls (like calldesk.calls including defaults) on commit drop")
    with cur.copy("copy t_calls (source, call_key, call_at, phone, direction, call_type, status, answered, duration_s, agent,"
                  " customer_name, line, dtmf, notes, disposition, campaign, talk_s, recording) from stdin") as cp:
        for r in rows:
            cp.write_row(r)
    cur.execute("""insert into calldesk.calls (source, call_key, call_at, phone, direction, call_type, status, answered,
                                               duration_s, agent, customer_name, line, dtmf, notes, disposition, campaign,
                                               talk_s, recording)
                   select distinct on (source, call_key) source, call_key, call_at, phone, direction, call_type, status,
                          answered, duration_s, agent, customer_name, line, dtmf, notes, disposition, campaign, talk_s,
                          recording from t_calls
                   on conflict (source, call_key) do update set direction = excluded.direction,
                          status = excluded.status, answered = excluded.answered, duration_s = excluded.duration_s,
                          customer_name = excluded.customer_name, line = excluded.line, dtmf = excluded.dtmf,
                          notes = excluded.notes, disposition = excluded.disposition, campaign = excluded.campaign,
                          talk_s = excluded.talk_s, recording = excluded.recording""")
    log.info("Call logs: %d rows loaded (%s .. %s)", cur.rowcount, first, last)
    return cur.rowcount


# ----------------------------------------------------------------------------- 2. reminders
def load_reminders(cur, today):
    d_from, d_to = today - dt.timedelta(days=1), today + dt.timedelta(days=3)
    _, _, items = rc.parse_reminders(rc.export_reminders(d_from, d_to))
    phones = rc.phones_for({i["patient_id"] for i in items if i["patient_id"]})
    rows = {}
    for i in items:
        if not i["due"] or not i["patient_id"] or not i["purpose"]:
            continue
        name_phone = norm_phone(i["first"]) if re.fullmatch(r"[\d +\-]{10,}", i["first"] or "") else ""
        db_name, db_phone = phones.get(i["patient_id"], ("", ""))
        client = " ".join(x for x in (i["first"], i["last"]) if x and x not in ("-", ".")) if not name_phone else ""
        rows[(i["due"], i["patient_id"], i["purpose"])] = (
            i["due"], i["patient_id"], i["purpose"][:300], i["pet"], client or db_name, name_phone or db_phone,
            rc.short_clinic(i["clinic"]), i["species"])
    cur.execute("delete from calldesk.reminders where due between %s and %s", (d_from, d_to))
    cur.executemany("""insert into calldesk.reminders (due, patient_id, purpose, pet, client, phone, clinic, species)
                       values (%s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing""", list(rows.values()))
    log.info("Reminders: %d loaded (due %s .. %s)", len(rows), d_from, d_to)
    return len(rows)


# ----------------------------------------------------------------------------- 3. appointments
def xl_dt(v):
    if isinstance(v, tuple) and v[0] == "date":
        return dt.datetime(1899, 12, 30) + dt.timedelta(days=v[1])
    return cf.parse_dt(v) if v else None


def load_appointments(cur, today, start=None):
    # 2 days back (cancellations / no-shows) .. 14 days ahead (so a rebooked appointment is seen);
    # --appt-from loads every day from that date instead (history for incentives)
    first = start or today - dt.timedelta(days=2)
    days = [first + dt.timedelta(days=k) for k in range((today + dt.timedelta(days=14) - first).days + 1)]
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (VetBuddy call desk)"
    vb.login(s)
    col = {c.lower(): i for i, c in enumerate(ap.EXPORT_COLUMNS)}
    g = lambda row, name: row[col[name.lower()]]   # noqa: E731
    n = 0
    for day in days:
        got = {}

        def fetch(day=day):
            got["rows"] = ap.parse_xls(ap.download_xls(s, day))

        if not vb.retry(f"Appointments {day}", fetch, 3, 45):
            log.error("Appointments for %s not loaded", day)
            continue
        recs = []
        for row in got["rows"]:
            aid = str(g(row, "Appointment ID") or "").strip()
            if not aid:
                continue
            txt = lambda v: (str(v).strip() if v not in (None, "") else None)   # noqa: E731
            recs.append((aid, ap.appt_date(g(row, "Appointment Time")) or day, txt(g(row, "Appointment Time")),
                         xl_dt(g(row, "Creation Time")), txt(g(row, "Client")), txt(g(row, "Patient")),
                         norm_phone(g(row, "Phone")) or txt(g(row, "Phone")), txt(g(row, "Status")),
                         txt(g(row, "Appointment Type")), txt(g(row, "Complaint")),
                         rc.short_clinic(txt(g(row, "Clinic")) or ""), txt(g(row, "Created By")),
                         txt(g(row, "Reason For Cancellation"))))
        cur.executemany("""insert into calldesk.appointments (appt_id, appt_date, appt_time, created_at, client, pet, phone,
                             status, appt_type, complaint, clinic, created_by, cancel_reason)
                           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           on conflict (appt_id) do update set appt_date = excluded.appt_date,
                             appt_time = excluded.appt_time, status = excluded.status, phone = excluded.phone,
                             appt_type = excluded.appt_type, cancel_reason = excluded.cancel_reason,
                             clinic = excluded.clinic, loaded_at = now()""", recs)
        st = Counter(r[7] for r in recs)
        log.info("Appointments %s: %d (%s)", day, len(recs), ", ".join(f"{k}={v}" for k, v in st.most_common(6)))
        n += len(recs)
    return n


# ----------------------------------------------------------------------------- 4. Lead Box
def load_leads(cur, today):
    sp = cf.SharePoint.from_env()
    n = 0
    for back in (3, 2, 1):
        d = today - dt.timedelta(days=back)
        for ext in (".csv", ".xlsx", ".xls"):
            name = f"Corefactor_LeadBox_{d.isoformat()}{ext}"
            try:
                data, _ = sp.download(f"{LEADBOX_FOLDER.strip('/')}/{name}")
            except Exception:  # noqa: BLE001
                continue
            recs = []
            for r in rc.read_table(name, data):
                ph = norm_phone(rc.pick(r, "Phone", "Mobile", "Phone Number", "Mobile Number", "Contact Number",
                                        "Customer Number", "Lead Number"))
                if not ph:
                    continue
                created = cf.parse_dt(rc.pick(r, "Created Date", "Created On", "Created At", "Date")) or \
                    dt.datetime.combine(d, dt.time(12))
                status = " / ".join(str(x) for x in (rc.pick(r, "Status", "Lead Status", "Stage"),
                                                     rc.pick(r, "Disposition"),
                                                     rc.pick(r, "Appt Booked", "Appointment Booked")) if x)
                recs.append((key("lead", ph, created, rc.pick(r, "Lead Id", "Lead ID", "Id") or ""), created, ph,
                             str(rc.pick(r, "Name", "Lead Name", "Customer Name", "Pet Parent Name") or "")[:120],
                             str(rc.pick(r, "Purpose Of Calling", "Purpose of Calling", "Purpose", "Service",
                                         "Requirement", "Enquiry") or "")[:200],
                             status[:200], str(rc.pick(r, "Branch", "Unit", "Clinic", "Location") or "")[:60],
                             json.dumps({k: str(v) for k, v in r.items() if v not in (None, "")}, default=str)[:20000]))
            cur.executemany("""insert into calldesk.leads (lead_key, created_at, phone, name, purpose, status, unit, raw)
                               values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                               on conflict (lead_key) do update set status = excluded.status, raw = excluded.raw,
                                 loaded_at = now()""", recs)
            log.info("Lead Box %s: %d leads", d, len(recs))
            n += len(recs)
            break
        else:
            log.warning("No Lead Box file for %s", d)
    return n


# ----------------------------------------------------------------------------- main
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Call Desk daily load + list build")
    p.add_argument("--day", help="list day YYYY-MM-DD (default: today IST)")
    p.add_argument("--days", type=int, default=3, help="days of call logs to (re)load (default 3)")
    p.add_argument("--only", choices=["calls", "reminders", "appointments", "leads", "build", "rebalance"], action="append",
                   help="run only these steps (repeatable)")
    p.add_argument("--source", choices=["corefactor", "runo"], help="calls step: only this source (default both)")
    p.add_argument("--appt-from", type=dt.date.fromisoformat, help="appointments step: load every day from this date")
    p.add_argument("--rebuild", action="store_true", help="rebuild the day's list (rows nobody touched yet)")
    p.add_argument("--no-build", action="store_true", help="load only, do not build the list")
    a = p.parse_args(argv)
    today = dt.date.fromisoformat(a.day) if a.day else dt.datetime.now(IST).date()
    if not vetbuddy_sql.ENABLED:
        log.error("SUPABASE_DB_URL missing")
        return 1
    steps = [("calls", lambda cur: load_calls(cur, today, a.days, a.source)),
             ("reminders", lambda cur: load_reminders(cur, today)),
             ("appointments", lambda cur: load_appointments(cur, today, a.appt_from)),
             ("leads", lambda cur: load_leads(cur, today))]
    failed = []
    with vetbuddy_sql.connect() as conn:
        for name, fn in steps:
            if a.only and name not in a.only:
                continue
            try:
                with conn.cursor() as cur:
                    fn(cur)
                conn.commit()
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                failed.append(name)
                log.error("%s failed: %s", name, e, exc_info=True)
        if a.only and "rebalance" in a.only:
            # 24 Nov 2026: agents added after the morning build get numbers; everyone topped up / trimmed to target
            # (untouched rows only - what agents already worked on stays with them)
            with conn.cursor() as cur:
                cur.execute("set local statement_timeout = '15min'")
                cur.execute("select calldesk.rebalance_today(%s, true)", (today,))
                stats = cur.fetchone()[0]
            conn.commit()
            log.info("Rebalanced %s: %s", today, json.dumps(stats))
        if not a.no_build and (not a.only or "build" in a.only):
            with conn.cursor() as cur:
                # the database default is 2 minutes; building and balancing 30 agents' lists can take longer
                cur.execute("set local statement_timeout = '15min'")
                cur.execute("select calldesk.build_list(%s, %s)", (today, a.rebuild))
                stats = cur.fetchone()[0]
            conn.commit()
            log.info("List for %s: %s", today, json.dumps(stats))
    if failed:
        log.error("Steps that failed (the list was still built from the rest): %s", ", ".join(failed))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
