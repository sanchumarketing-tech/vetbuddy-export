#!/usr/bin/env python3
"""
Gofrugal data-sync checkpoint (19 Nov 2026) - run before reports 3111 / 3126 are downloaded.

Gofrugal HQ only has an outlet's bills after that outlet's backup has synced. The HQ page
NetTrade > Data Sync > Configuration > Backup config lists every outlet with its last successful
sync time ("Data as on") and its backup status. Before the pharmacy download:
  1. every outlet except the inactive / old ones (GOFRUGAL_SKIP_OUTLETS: Ecommerce, Whitefield, Koramangala 1-3,
     Palavakkam, Coimbatore 2-3, Anna Nagar 2-5, Warehouse, Warehouse VOW) must have synced at or after 11:59 PM of the report's last day (yesterday);
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
                                    or "Sanchu Ecommerce,Sanchu Whitefield,Sanchu Koramangala,"          # inactive (19-11-2026)
                                       "Sanchu Palavakkam,Sanchu Koramangala 2,Sanchu Koramangala 3,"
                                       "Sanchu Coimbatore 2,Sanchu Coimbatore 3,Sanchu Anna Nagar 2,"
                                       "Sanchu Anna Nagar 3,Sanchu Anna Nagar 4,Sanchu Warehouse VOW,"
                                       "Sanchu Warehouse,Sanchu Anna Nagar 5"    # 20-11-2026: no pharmacy sales in 45 days
                                       ).split(",") if s.strip()}
# 20-11-2026: only these shops must be synced (the ones that bill). Every other outlet is ignored.
WATCH = {s.strip().lower() for s in (os.environ.get("GOFRUGAL_WATCH_OUTLETS")
                                     or "Sanchu Adyar,Sanchu Anna Nagar,Sanchu Velachery,Sanchu Neelangarai,"
                                        "Sanchu Valasaravakkam,Sanchu Coimbatore,Sanchu Madurai").split(",") if s.strip()}
HQ_PASS = os.environ.get("GOFRUGAL_HQ_PASS", "")
# the login that may open Backup config (the report login cannot: 403). The checkpoint is ON only when set.
SYNC_USER = os.environ.get("GOFRUGAL_SYNC_USER", "")
SYNC_PASS = os.environ.get("GOFRUGAL_SYNC_PASS", "")
READY = bool(SYNC_USER and SYNC_PASS)


def new_session():
    gs = gofrugal.Session()
    gs.login(SYNC_USER or None, SYNC_PASS or None)
    return gs
CUTOFF = os.environ.get("GOFRUGAL_SYNC_CUTOFF", "23:59")        # of the report's last day
WAIT_MIN = float(os.environ.get("GOFRUGAL_SYNC_WAIT_MIN", "5"))     # after the Incremental request, look again once after 5 min
RECHECKS = int(os.environ.get("GOFRUGAL_SYNC_RECHECKS", "1"))       # 20-11-2026: one re-check per run (no polling)
RESEND_MIN = float(os.environ.get("GOFRUGAL_SYNC_RESEND_MIN", "60"))   # Active / Incremental sent once per run
AFTER_OK_MIN = float(os.environ.get("GOFRUGAL_SYNC_AFTER_OK_MIN", "0"))  # 20-11-2026: download at once when synced
UNTIL = os.environ.get("GOFRUGAL_SYNC_UNTIL", "09:15")             # never wait past this (IST) - the report is due by 9:30


def _open_page(gs):
    """Open the Backup config page once, as the browser does (sets up the HQ page session)."""
    if getattr(gs, "_bk_page", False):
        return
    for u in ("RayMedi_HQ/mainIndex.do", "RayMedi_HQ/mainIndex.do?page=ngx-framework-client%2Findex.html%23%2Fbackup-configuration",
              "RayMedi_HQ/ngx-framework-client/index.html", "RayMedi_HQ/rest/hq/userinfo",
              "RayMedi_HQ/rest/outletbackup/getlogindetails"):
        r = gs.s.get(f"{gofrugal.BASE}/{u}", timeout=60)
        log.info("  open %s -> %s", u.split("?")[0], r.status_code)
    gs._bk_page = True


def _hq(gs, method, path, **kw):
    _open_page(gs)
    url = f"{gofrugal.BASE}/RayMedi_HQ/{path}"
    hdr = {"Referer": f"{gofrugal.BASE}/RayMedi_HQ/ngx-framework-client/index.html",
           "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/plain, */*"}
    hdr.update(kw.pop("headers", {}))
    r = gs.s.request(method, url, timeout=120, headers=hdr, **kw)
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
    watched = [o for o in rows if o["name"].lower() in WATCH]
    missing = WATCH - {o["name"].lower() for o in watched}
    late = [o for o in watched if o["last"] is None or o["last"] < cutoff]
    # a watched shop that is not in Gofrugal's list at all counts as not synced (safe side)
    late += [{"id": "", "name": m, "last": None, "status": "not in Gofrugal list", "remarks": ""} for m in sorted(missing)]
    return watched, late


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
        flag = "not watched" if o["name"].lower() not in WATCH else ("OK" if o["last"] and o["last"] >= cutoff else "BEHIND")
        log.info("  %-26s %-19s %-9s %s", o["name"], o["last"].strftime("%d-%m-%Y %H:%M") if o["last"] else "-",
                 o["status"], flag)


def ensure(last_day: dt.date, deadline: dt.datetime, gs=None, on_status=None) -> bool:
    """True when every watched outlet has synced past the cut-off (requests a sync if needed)."""
    gs = gs or new_session()
    h, m = (int(x) for x in CUTOFF.split(":"))
    cutoff = dt.datetime.combine(last_day, dt.time(h, m))
    def tell(state, late):
        if on_status:
            try:
                on_status({"date": dt.datetime.now(IST).strftime("%Y-%m-%d"), "checked_at": dt.datetime.now(IST).strftime("%Y-%m-%d %H:%M"),
                           "needed": cutoff.strftime("%Y-%m-%d %H:%M"), "state": state,
                           "behind": [{"outlet": o["name"], "data_as_on": o["last"].strftime("%Y-%m-%d %H:%M") if o["last"] else "",
                                       "status": o["status"]} for o in late]})
            except Exception as e:  # noqa: BLE001
                log.warning("Could not save the sync status: %s", e)

    rows = outlets(gs)
    report(rows, cutoff, "Gofrugal data sync")
    watched, late = behind(rows, cutoff)
    tell("ok" if not late else "behind", late)
    if not late:
        log.info("Gofrugal data sync OK for all %d shops", len(watched))
        return True
    hh, mm = (int(x) for x in UNTIL.split(":"))
    deadline = min(deadline, dt.datetime.combine(dt.datetime.now(IST).date(), dt.time(hh, mm)))
    tries, last_sent = 0, None
    while True:
        tries += 1
        now = dt.datetime.now(IST).replace(tzinfo=None)
        if last_sent is None or now - last_sent >= dt.timedelta(minutes=RESEND_MIN):
            real = [o for o in late if o["id"]]
            susp = [o for o in real if o["status"].lower() != "active"]
            if susp:
                if HQ_PASS:
                    res = post_config(gs, 3, [o["id"] for o in susp], HQ_PASS)
                    log.info("Backup status -> Active for %s: %s", ", ".join(o["name"] for o in susp), res)
                else:
                    log.warning("Suspended shops %s need 'Backup status - Active', but GOFRUGAL_HQ_PASS is not set",
                                ", ".join(o["name"] for o in susp))
            active_late = [o for o in real if o["status"].lower() == "active" or (susp and HQ_PASS and o in susp)]
            if active_late:
                res = post_config(gs, 1, [o["id"] for o in active_late])
                log.info("Backup request - Incremental sent for %s: %s", ", ".join(o["name"] for o in active_late), res)
            last_sent = now
        if tries > RECHECKS or now + dt.timedelta(minutes=WAIT_MIN) > deadline:
            log.error("Gofrugal data sync still behind at %s (no waiting past %s): %s", now.strftime("%H:%M"),
                      deadline.strftime("%H:%M"), ", ".join(o["name"] for o in late))
            return False
        log.info("Waiting %s minutes for the sync (check %d)", WAIT_MIN, tries)
        time.sleep(WAIT_MIN * 60)
        rows = outlets(gs)
        report(rows, cutoff, f"Gofrugal data sync - check {tries}")
        watched, late = behind(rows, cutoff)
        tell("ok" if not late else "behind", late)
        if not late:
            log.info("Gofrugal data sync OK now for all %d shops - downloading", len(watched))
            if AFTER_OK_MIN:
                time.sleep(AFTER_OK_MIN * 60)
            return True


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
    now = dt.datetime.now(IST).replace(tzinfo=None)
    last_day = now.date() - dt.timedelta(days=1)
    gs = new_session()
    if "--check" in sys.argv:
        log.info("Secrets present: GOFRUGAL_SYNC_USER=%s, GOFRUGAL_SYNC_PASS=%s, GOFRUGAL_HQ_PASS=%s",
                 "yes" if SYNC_USER else "NO", "yes" if SYNC_PASS else "NO", "yes" if HQ_PASS else "NO")
        h, m = (int(x) for x in CUTOFF.split(":"))
        report(outlets(gs), dt.datetime.combine(last_day, dt.time(h, m)), "Gofrugal data sync (check only)")
        return 0
    deadline = now + dt.timedelta(minutes=int(os.environ.get("GOFRUGAL_SYNC_MAX_MIN", "25")))
    return 0 if ensure(last_day, deadline, gs) else 2


if __name__ == "__main__":
    sys.exit(main())
