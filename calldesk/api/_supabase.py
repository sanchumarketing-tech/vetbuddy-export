"""Shared helpers for the Call Desk Python functions on Vercel (not a URL itself: name starts with _)."""
import json
import os
import urllib.error
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ykmgbuooksizjqsyfhut.supabase.co").rstrip("/")
# public "anon" key - safe to ship: every cd_* function checks the session token itself
SUPABASE_ANON = os.environ.get("SUPABASE_ANON_KEY") or (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrbWdidW9va3Npempxc3lmaHV0Iiwicm9sZSI6ImFub24i"
    "LCJpYXQiOjE3OTM3Nzk0MzcsImV4cCI6MjEwOTM1NTQzN30.-mfbJPEfIUIjgTboxviFqqMCHX7ex2Lh95ql-bTcDuQ")
COOKIE = "cd_session"
MAX_AGE = 12 * 3600          # same as the session in the database


def call_rpc(fn, args, token=None):
    """POST /rest/v1/rpc/<fn> -> (status, body bytes)."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{fn}", data=json.dumps(args or {}).encode(), method="POST",
        headers={"apikey": SUPABASE_ANON, "Authorization": f"Bearer {SUPABASE_ANON}",
                 "Content-Type": "application/json", **({"x-cd-token": token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return 502, json.dumps({"message": f"Database not reachable: {e}"}).encode()


def read_cookie(handler):
    raw = handler.headers.get("Cookie") or ""
    for part in raw.split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE and v:
            return v
    return None


def session_cookie(token, max_age=MAX_AGE):
    return f"{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Strict"


def read_json(handler, limit=100_000):
    n = int(handler.headers.get("Content-Length") or 0)
    if n <= 0 or n > limit:
        return {}
    try:
        return json.loads(handler.rfile.read(n) or b"{}")
    except ValueError:
        return {}


def send(handler, status, body, cookie=None):
    data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    if cookie:
        handler.send_header("Set-Cookie", cookie)
    handler.end_headers()
    handler.wfile.write(data)
