"""POST /api/corefactor-calls?key=<key>   (Corefactor's live call push)

Accepts JSON, form-encoded or query-string fields; passes them to calldesk.cf_webhook in Supabase,
which checks the key, keeps the raw push and saves the call. GET with the key answers {"ok": true} so
Corefactor can test the link.
"""
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, send  # noqa: E402

LIMIT = 200_000


def _query(h):
    q = urllib.parse.urlparse(h.path).query
    return {k: v[-1] for k, v in urllib.parse.parse_qs(q, keep_blank_values=True).items()}


class handler(BaseHTTPRequestHandler):
    def _go(self, body):
        q = _query(self)
        key = q.pop("key", None) or self.headers.get("x-api-key") or self.headers.get("x-webhook-key")
        if not key:
            return send(self, 401, {"ok": False, "message": "key missing"})
        if not body and q:
            body = q                      # some systems send the fields in the URL
        status, raw = call_rpc("cf_webhook", {"p_key": key, "p_body": body})
        try:
            ans = json.loads(raw)
        except ValueError:
            ans = {"ok": False}
        if status != 200:
            return send(self, 502, {"ok": False, "message": "database error"})
        send(self, 200 if ans.get("ok") else 401, ans)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > LIMIT:
            return send(self, 413, {"ok": False, "message": "too large"})
        data = self.rfile.read(n) if n > 0 else b""
        ctype = (self.headers.get("Content-Type") or "").lower()
        body = {}
        if data:
            if "form" in ctype:
                body = {k: v[-1] for k, v in urllib.parse.parse_qs(data.decode("utf-8", "replace")).items()}
            else:
                try:
                    body = json.loads(data)
                except ValueError:
                    body = {"_raw": data.decode("utf-8", "replace")[:20000]}
        self._go(body)

    def do_GET(self):
        q = _query(self)
        if len(q) <= 1:                   # just the key: a link test
            key = q.get("key")
            status, raw = call_rpc("cf_webhook_ping", {"p_key": key or ""})
            ok = status == 200 and raw.strip() == b"true"
            return send(self, 200 if ok else 401, {"ok": ok})
        self._go({})
