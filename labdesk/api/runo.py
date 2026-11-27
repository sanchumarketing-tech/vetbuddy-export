"""POST /api/runo  {"phones": ["9876543210", ...]}  ->  today's Runo outgoing calls to those numbers.

Reads the "Live" tab of the RUNO Call Log Live Google Sheet (filled by Runo within a minute or two of
each call) through Google's sheet query link - only today's outgoing calls, about 10 KB - so the
database is not used for this. The answer is kept 60 seconds, so many open boards cost one read a minute.
Signed-in users only (Call Desk login).
"""
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, read_cookie, read_json, send  # noqa: E402

SHEET = os.environ.get("RUNO_LIVE_SHEET", "1j9fR1yC0LfF0HumZyMROhnvariuC2Wyn2Lyp0ms8RvA")
TAB = os.environ.get("RUNO_LIVE_TAB", "Live")
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
_cache = {"at": 0.0, "day": None, "calls": {}, "rows": 0, "err": None}
_seen_tokens = {}            # token -> time checked (saves a database call on every refresh)


def phone10(v):
    d = re.sub(r"\D", "", str(v or ""))
    return d[-10:] if len(d) >= 10 else ""


def load_today():
    now = time.time()
    today = dt.datetime.now(IST).date()
    if now - _cache["at"] < 60 and _cache["day"] == today:
        return _cache
    q = (f"select D,E,F,G,H,J where F='outgoing' and E >= datetime '{today:%Y-%m-%d} 00:00:00' "
         f"and E < datetime '{today + dt.timedelta(days=1):%Y-%m-%d} 00:00:00'")
    url = (f"https://docs.google.com/spreadsheets/d/{SHEET}/gviz/tq?tqx=out:csv&sheet={urllib.parse.quote(TAB)}"
           f"&tq={urllib.parse.quote(q)}")
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            text = r.read().decode("utf-8", "replace")
        calls = {}
        rows = list(csv.reader(io.StringIO(text)))
        for row in rows[1:]:
            if len(row) < 6:
                continue
            ph, start, _, tag, dur, caller = row[:6]
            p = phone10(ph)
            if not p:
                continue
            secs = int(float(dur or 0)) if re.fullmatch(r"\d+(\.\d+)?", dur or "") else 0
            calls.setdefault(p, []).append({
                "t": start[-8:-3] if len(start) >= 8 else start,     # HH:MM
                "by": caller.replace("Sanchu ", "").strip(),
                "secs": secs,
                "ok": secs > 0 and tag.lower() != "unanswered"})
        for v in calls.values():
            v.sort(key=lambda c: c["t"])
        _cache.update(at=now, day=today, calls=calls, rows=len(rows) - 1, err=None)
    except Exception as e:  # noqa: BLE001 - keep the last answer, say it is old
        _cache.update(err=f"Runo sheet not reachable: {e}")
        if _cache["day"] != today:
            _cache.update(day=today, calls={}, rows=0, at=now)
    return _cache


def signed_in(token):
    t = _seen_tokens.get(token)
    if t and time.time() - t < 600:
        return True
    status, raw = call_rpc("cd_me", {}, token)
    ok = status == 200 and raw.strip() not in (b"null", b"")
    if ok:
        _seen_tokens[token] = time.time()
    return ok


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        token = read_cookie(self)
        if not token or not signed_in(token):
            return send(self, 401, {"message": "signed out"})
        phones = read_json(self, limit=200_000).get("phones") or []
        c = load_today()
        out = {p: c["calls"][p] for p in {phone10(x) for x in phones if x} if p in c["calls"]}
        send(self, 200, {"day": str(c["day"]), "checked": dt.datetime.fromtimestamp(c["at"], IST).strftime("%H:%M"),
                         "calls_today": c["rows"], "error": c["err"], "calls": out})
