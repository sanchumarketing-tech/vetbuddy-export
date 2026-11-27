"""POST /api/login  {"user": "<email or name>", "pin": "1234"}  ->  sets the session cookie."""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, read_json, send, session_cookie  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = read_json(self)
        user, pin = str(body.get("user", "")).strip(), str(body.get("pin", "")).strip()
        if not user or not pin:
            return send(self, 400, {"ok": False, "msg": "Type your name / email and PIN."})
        status, raw = call_rpc("lf_login", {"p_user": user, "p_pin": pin})
        try:
            res = json.loads(raw or b"{}")
        except ValueError:
            res = {}
        if status != 200 or not isinstance(res, dict):
            return send(self, 502, {"ok": False, "msg": "Login is not available right now. Try again in a minute."})
        if not res.get("ok"):
            return send(self, 401, {"ok": False, "msg": res.get("msg") or "Wrong name / email or PIN."})
        return send(self, 200, {"ok": True, "name": res.get("name"), "role": res.get("role")},
                    cookie=session_cookie(res["token"]))

    def do_GET(self):
        send(self, 405, {"ok": False, "msg": "Use POST"})
