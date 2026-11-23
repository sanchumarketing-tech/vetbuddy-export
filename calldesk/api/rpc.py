"""POST /api/rpc  {"fn": "cd_list", "args": {...}}  ->  the Supabase function's answer.

Only the Call Desk functions below can be called. The session token stays in the HttpOnly cookie
(the page never sees it) and is passed to Supabase as the header x-cd-token.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, read_cookie, read_json, send, session_cookie  # noqa: E402

ALLOWED = {"cd_incentives", "cd_agent_incentive", "cd_skip", "cd_pet", "cd_skip_called", "cd_reason_set", "cd_me", "cd_list", "cd_calls", "cd_bills", "cd_dial", "cd_save", "cd_team",
           "cd_agent_save", "cd_assign", "cd_kpi", "cd_mark_called", "cd_log",
           "cd_card_extras", "cd_pitch_save", "cd_vacc_note_save",
           "cd_pet_deceased", "cd_pet_deceased_list", "cd_dnd",
           "cd_card_open", "cd_card_close", "cd_alerts", "cd_alert_ack"}


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
        if status in (401, 403):      # 'not allowed' for this request (the app checks cd_me to see if still signed in)
            return send(self, 403, raw)
        send(self, status, raw)
