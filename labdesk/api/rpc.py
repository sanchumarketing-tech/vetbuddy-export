"""POST /api/rpc  {"fn": "lf_board"}  ->  the Supabase function's answer (Lab Follow-up board).

Lab Follow-up has its own logins (lab.agents). The session token stays in the HttpOnly cookie and is passed
to Supabase as the header x-lf-token. Only the functions below can be called; each checks the login itself.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, read_cookie, read_json, send, session_cookie  # noqa: E402

ALLOWED = {"lf_board", "lf_me", "lf_note_save", "lf_notes", "lf_agents", "lf_agent_save"}


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
        if fn == "lf_me" and status == 200 and raw.strip() in (b"null", b""):
            return send(self, 401, {"message": "signed out"}, cookie=session_cookie("", max_age=0))
        if status in (401, 403) or b"not allowed" in raw[:300]:
            # signed out - or a team-lead page asked by an agent: the page checks lf_me to tell which
            if fn in ("lf_board", "lf_me"):
                return send(self, 401, {"message": "signed out"}, cookie=session_cookie("", max_age=0))
            return send(self, 403, {"message": "Only team leads can do this."})
        send(self, status, raw)
