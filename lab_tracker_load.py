#!/usr/bin/env python3
"""
Lab Abnormal Follow-up board: Lab Test Tracker (SharePoint) -> Supabase lab.reports -> lab.refresh().

Every morning, after the VetBuddy (06:47) and Runo (07:13) jobs:
  1. Downloads the Lab Test Tracker Excel from SharePoint / OneDrive (read only - nothing is written back).
  2. Takes the "Abnormal" rows of the last --days days (default 45) and combines the tests of the same
     pet on the same day into one report (same as the Excel follow-up report of 27 Nov 2026).
  3. Replaces those days in lab.reports (so a corrected row in the tracker is picked up), then runs
     lab.refresh(): pets whose VetBuddy bill (same client + pet id) came after the report leave the board.
See sql/48_lab_followup.sql. The website (labdesk/) reads public.lf_board().

Environment:
  SUPABASE_DB_URL                                 (secret) same as the other jobs
  SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET    (secrets) same Azure app as the other jobs
  SP_LAB_SITE_URL    site or OneDrive that holds the tracker, e.g. https://sanchuhospital-my.sharepoint.com/personal/<user>
  SP_LAB_LIBRARY     library there (default "Documents")
  SP_LAB_PATH        path of the file inside the library, e.g. "Lab/Lab Test Tracker.xlsx" - or leave it empty:
                     the file named SP_LAB_FILE is then searched for in the whole OneDrive / library
  SP_LAB_FILE        file name to search for (default "Lab Test Tracker.xlsx")
  SP_LAB_SHEET       worksheet (default: the first sheet)

Usage:
  python lab_tracker_load.py                  last 45 days + refresh
  python lab_tracker_load.py --file x.xlsx    read a local file instead of SharePoint
  python lab_tracker_load.py --refresh-only   just rebuild the board
"""

import argparse
import datetime as dt
import io
import logging
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import corefactor_calllogs_export as cf          # noqa: E402  SharePoint helper, env, IST
import vetbuddy_sql                              # noqa: E402  Supabase connection

log = logging.getLogger("labtracker")
env = cf.env
IST = cf.IST
HEADERS = {"date": "date", "client id": "client", "pet id": "pet", "pet name": "pet_name",
           "test name": "test", "clinic name": "clinic", "normal/abnormal": "status", "remarks": "remarks"}


def text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v == int(v):
        v = int(v)
    return str(v).strip()


def as_date(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = text(v)
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d.%m.%Y", "%d-%b-%Y", "%d %b %Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def download_tracker():
    sp = cf.SharePoint.from_env("SP_LAB_SITE_URL", "SP_LAB_LIBRARY")
    path = env("SP_LAB_PATH")
    if path:
        return sp.download(path)[0]
    name = env("SP_LAB_FILE", "Lab Test Tracker.xlsx")
    q = name.replace("'", "''")
    found = sp._get(f"{cf.GRAPH}/drives/{sp.drive}/root/search(q='{q}')").json().get("value", [])
    hits = [f for f in found if f.get("name", "").lower() == name.lower() and "file" in f]
    if not hits:
        raise cf.RunError(f"'{name}' not found in {env('SP_LAB_SITE_URL')} - set SP_LAB_PATH.")
    hits.sort(key=lambda f: f.get("lastModifiedDateTime", ""), reverse=True)
    f = hits[0]
    where = (f.get("parentReference", {}).get("path", "").split("root:")[-1] + "/" + f["name"]).lstrip("/")
    log.info("Tracker found: %s (changed %s)%s", where, f.get("lastModifiedDateTime"),
             f" - {len(hits)} files with that name, using the newest" if len(hits) > 1 else "")
    return sp._get(f"{cf.GRAPH}/drives/{sp.drive}/items/{f['id']}/content").content


def read_tracker(data, sheet=None):
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    head = None
    for r in rows:                                    # the header row: the first row with "Client ID"
        names = [text(c).lower() for c in r]
        if "client id" in names and "date" in names:
            head = {HEADERS[n]: i for i, n in enumerate(names) if n in HEADERS}
            break
    if not head or not {"date", "client", "pet", "status"} <= head.keys():
        raise cf.RunError(f"Tracker: header row with Date / Client ID / Pet ID / Normal/Abnormal not found "
                          f"(sheet '{ws.title}').")
    out = []
    for r in rows:
        def g(k):
            i = head.get(k)
            return r[i] if i is not None and i < len(r) else None
        if text(g("status")).lower() != "abnormal":
            continue
        d, client, pet = as_date(g("date")), text(g("client")), text(g("pet"))
        if not d or not client or not pet:
            continue
        out.append({"date": d, "client": client, "pet": pet, "pet_name": text(g("pet_name")),
                    "test": text(g("test")), "clinic": text(g("clinic")), "remarks": text(g("remarks"))})
    log.info("Tracker '%s': %d abnormal rows", ws.title, len(out))
    return out


def combine(rows):
    """One report per pet per day: tests (and remarks) of that day joined."""
    reps = {}
    for r in rows:
        k = (r["date"], r["client"], r["pet"])
        x = reps.setdefault(k, {"pet_name": r["pet_name"], "clinic": r["clinic"], "tests": [], "remarks": []})
        if r["test"] and r["test"] not in x["tests"]:
            x["tests"].append(r["test"])
        if r["remarks"] and r["remarks"] not in x["remarks"]:
            x["remarks"].append(r["remarks"])
        x["pet_name"] = x["pet_name"] or r["pet_name"]
        x["clinic"] = x["clinic"] or r["clinic"]
    return reps


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=45, help="days back to (re)load (default 45)")
    ap.add_argument("--file", help="local tracker file instead of SharePoint")
    ap.add_argument("--refresh-only", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
        if not a.refresh_only:
            if a.file:
                data = Path(a.file).read_bytes()
            else:
                data = download_tracker()
            rows = read_tracker(data, env("SP_LAB_SHEET") or None)
            today = dt.datetime.now(IST).date()
            first = today - dt.timedelta(days=a.days)
            reps = {k: v for k, v in combine(rows).items() if first <= k[0] <= today}
            if not reps:
                raise cf.RunError(f"No abnormal reports from {first} in the tracker - board not changed.")
            last = max(k[0] for k in reps)
            if last < today - dt.timedelta(days=3):
                log.warning("The tracker's latest abnormal report is %s - is the tracker being updated?", last)
            cur.execute("delete from lab.reports where report_date >= %s", (first,))
            with cur.copy("COPY lab.reports (report_date, client_id, pet_id, pet_name, clinic, unit, tests, "
                          "n_tests, remarks) FROM STDIN") as cp:
                for (d, client, pet), x in sorted(reps.items()):
                    cp.write_row([d, client, pet, x["pet_name"] or None, x["clinic"] or None, None,
                                  ", ".join(x["tests"]) or None, len(x["tests"]), "; ".join(x["remarks"]) or None])
            cur.execute("update lab.reports set unit = lab.unit_of(clinic) where report_date >= %s", (first,))
            cur.execute("insert into lab.load_log (rows_in, reports, last_report, note) values (%s, %s, %s, %s)",
                        (len(rows), len(reps), last, f"{first} to {today}"))
            log.info("Loaded %d reports (%s to %s, latest report %s)", len(reps), first, today, last)
        cur.execute("select lab.refresh()")
        log.info("Board rebuilt: %s", cur.fetchone()[0])
        cur.execute("select date_to from vetbuddy.v_data_freshness")
        vb_to = cur.fetchone()
        if vb_to and vb_to[0] < dt.datetime.now(IST).date() - dt.timedelta(days=1):
            log.warning("VetBuddy data only goes to %s - pets who came yesterday are still on the board.", vb_to[0])
        conn.commit()


if __name__ == "__main__":
    try:
        main()
    except cf.RunError as e:
        log.error("%s", e)
        sys.exit(1)
