"""POST /api/logout  ->  ends the session and clears the cookie."""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, read_cookie, send, session_cookie  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        token = read_cookie(self)
        if token:
            call_rpc("lf_logout", {}, token)
        send(self, 200, {"ok": True}, cookie=session_cookie("", max_age=0))
