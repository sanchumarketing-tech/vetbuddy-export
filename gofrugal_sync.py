#!/usr/bin/env python3
"""
Gofrugal data-sync checkpoint (19 Nov 2026) - run before reports 3111 / 3126 are downloaded.

Gofrugal HQ only has an outlet's bills after that outlet's backup has synced. The HQ page
NetTrade > Data Sync > Configuration > Backup config lists every outlet with its last successful
sync time ("Data as on") and its backup status. Before the pharmacy download:
  1. every outlet except the inactive ones (GOFRUGAL_SKIP_OUTLETS: Sanchu Ecommerce, Sanchu Whitefield,
     Sanchu Koramangala) must have synced at or after 11:30 PM of the report's last day (yesterday);
  2. if not: outlets whose backup status is "Suspended" are set back to "Backup status - Active"
     (this needs the HQ password: GitHub secret GOFRUGAL_HQ_PASS), then a
     "Backup request - Incremental" is sent for the outlets that are behind - same as doing it on the page;
  3. after 5 minutes the sync times are checked again (a few times, until the deadline);
  4. once every outlet is up to date, wait 5 more minutes and only then download.
If it is still not up to date, the download is NOT done (so a half-synced file never reaches the report);
a later run retries, and the 9 AM sales script posts "Gofrugal data sync issue" on WhatsApp.

Usage:
  python gofrugal_sync.py --check        report the sync times only (changes nothing)
  python gofrugal_sync.py --ensure       the full checkpoint (exit 0 = ready, 2 = not ready)
"""
import datetime as dt
import logging
import os
import sys
import time

import gofrugal

log = logging.getLogger("vetbuddy")
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
SKIP = {s.strip().lower() for s in (os.environ.get("GOFRUGAL_SKIP_OUTLETS")
                                    or "Sanchu Ecommerce,Sanchu Whitefield,Sanchu Koramangala").split(",") if s.strip()}
HQ_PASS = os.environ.get("GOFRUGAL_HQ_PASS", "")
CUTOFF = os.environ.get("GOFRUGAL_SYNC_CUTOFF", "23:30")        # of the report's last day
WAIT_MIN = int(os.environ.get("GOFRUGAL_SYNC_WAIT_MIN", "5"))


def _hq(gs, method, path, **kw):
    url = f"{gofrugal.BASE}/RayMedi_HQ/{path}"
    r = gs.s.request(method, url, timeout=120, **kw)
    if r.status_code in (401, 403):
        raise RuntimeError(f"Gofrugal HQ refused {path.split('?')[0]} ({r.status_code}) - is this login allowed to use Backup config?")
    return r


def outlets(gs):
    """[{id, name, last (datetime or None), status, remarks}] from the Backup config page."""
    r = _hq(gs, "get", "jsonServlet.view?ajax_id=outletBackupRequest&limit=-1")
    try:
        j = r.json()
    except ValueError:
        raise RuntimeError("Gofrugal Backup config list not readable (session expired?)")
    cols = [c.upper() for c in j.get("columnNames", [])]
    out = []
    for row in j.get("data", []):
        d = dict(zip(cols, row))
        last = None
        try:
            last = dt.datetime.strptime(str(d.get("LAST_SUCCESS_TIME") or "")[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
        out.append({"id": str(d.get("OUTLET_ID")), "name": str(d.get("OUTLET_NAME") or "").strip(),
                    "last": last, "status": str(d.get("STATUS") or ""), "remarks": str(d.get("REMARKS") or "")})
    return out


def behind(rows, cutoff):
    watched = [o for o in rows if o["name"].lower() not in SKIP]
    return watched, [o for o in watched if o["last"] is None or o["last"] < cutoff]


def post_config(gs, req, ids, passwd=""):
    """req 1 = Backup request - Incremental (no password), 3 = Backup status - Active (HQ password)."""
    r = _hq(gs, "post", "backupConfig.view", headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={"tranyear": "", "outletList": ",".join(ids), "passwd": passwd, "req": str(req)})
    text = r.text.strip()
    if "<" in text or "hqlogout" in text:
        raise RuntimeError("Gofrugal session expired while updating Backup config")
    return text


def report(rows, cutoff, title):
    log.info("%s (needed: synced at or after %s)", title, cutoff.strftime("%d-%m-%Y %H:%M"))
    for o in sorted(rows, key=lambda x: x["name"]):
        flag = "skip (inactive)" if o["name"].lower() in SKIP else ("OK" if o["last"] and o["last"] >= cutoff else "BEHIND")
        log.info("  %-26s %-19s %-9s %s", o["name"], o["last"].strftime("%d-%m-%Y %H:%M") if o["last"] else "-",
                 o["status"], flag)


def ensure(last_day: dt.date, deadline: dt.datetime, gs=None) -> bool:
    """True when every watched outlet has synced past the cut-off (requests a sync if needed)."""
    gs = gs or gofrugal.Session()
    if not gs.role_id:
        gs.login()
    h, m = (int(x) for x in CUTOFF.split(":"))
    cutoff = dt.datetime.combine(last_day, dt.time(h, m))
    rows = outlets(gs)
    report(rows, cutoff, "Gofrugal data sync")
    watched, late = behind(rows, cutoff)
    if not late:
        log.info("Gofrugal data sync OK for all %d outlets", len(watched))
        return True
    tries = 0
    while True:
        tries += 1
        susp = [o for o in late if o["status"].lower() != "active"]
        if susp:
            if HQ_PASS:
                res = post_config(gs, 3, [o["id"] for o in susp], HQ_PASS)
                log.info("Backup status -> Active for %s: %s", ", ".join(o["name"] for o in susp), res)
            else:
                log.warning("Suspended outlets %s need 'Backup status - Active', but GOFRUGAL_HQ_PASS is not set",
                            ", ".join(o["name"] for o in susp))
        active_late = [o for o in late if o["status"].lower() == "active" or (susp and HQ_PASS and o in susp)]
        if active_late:
            res = post_config(gs, 1, [o["id"] for o in active_late])
            log.info("Backup request - Incremental sent for %s: %s", ", ".join(o["name"] for o in active_late), res)
        if dt.datetime.now(IST).replace(tzinfo=None) + dt.timedelta(minutes=WAIT_MIN) > deadline:
            log.error("Gofrugal data sync still behind and no time left before %s", deadline.strftime("%H:%M"))
            return False
        log.info("Waiting %d minutes for the sync (check %d)", WAIT_MIN, tries)
        time.sleep(WAIT_MIN * 60)
        rows = outlets(gs)
        report(rows, cutoff, f"Gofrugal data sync - check {tries}")
        watched, late = behind(rows, cutoff)
        if not late:
            log.info("Gofrugal data sync OK now; waiting %d more minutes before downloading", WAIT_MIN)
            time.sleep(WAIT_MIN * 60)
            return True


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
    now = dt.datetime.now(IST).replace(tzinfo=None)
    last_day = now.date() - dt.timedelta(days=1)
    gs = gofrugal.Session()
    gs.login()
    if "--check" in sys.argv:
        h, m = (int(x) for x in CUTOFF.split(":"))
        report(outlets(gs), dt.datetime.combine(last_day, dt.time(h, m)), "Gofrugal data sync (check only)")
        return 0
    deadline = now + dt.timedelta(minutes=int(os.environ.get("GOFRUGAL_SYNC_MAX_MIN", "25")))
    return 0 if ensure(last_day, deadline, gs) else 2


if __name__ == "__main__":
    sys.exit(main())
