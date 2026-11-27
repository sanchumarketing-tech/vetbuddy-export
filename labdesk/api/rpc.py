"""POST /api/rpc  {"fn": "lf_board"}  ->  the Supabase function's answer (Lab Follow-up board).

Same login as the Call Desk: the session token stays in the HttpOnly cookie and is passed to Supabase
as the header x-cd-token. Only the functions below can be called.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, read_cookie, read_json, send, session_cookie  # noqa: E402

ALLOWED = {"lf_board", "cd_me"}


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        token = read_cookie(self)
        if not token:
            return send(self, 401, {"message": "signed out"})
        body = read_json(self)
        fn, args = body.get("fn"), body.get("args") or {}
        if fn not in ALLOWED or not isinstance(args, dict):
            return send(self, 400, {"message": "unknown request"})
        status, raw = call_rpc(fn, args, token)
        if fn == "cd_me" and status == 200 and raw.strip() in (b"null", b""):
            return send(self, 401, {"message": "signed out"}, cookie=session_cookie("", max_age=0))
        if status in (401, 403) or b"not allowed" in raw[:300]:
            return send(self, 401, {"message": "signed out"}, cookie=session_cookie("", max_age=0))
        send(self, status, raw)
