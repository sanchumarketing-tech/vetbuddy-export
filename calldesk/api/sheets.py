"""POST /api/sheets  - writes the agents' new DND / Deceased marks to the team's sheets at once (23 Nov 2026).

Called by the app right after a DND or a Deceased tick is saved (the agent does not wait for it).
Needs the Vercel environment variables SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET (the same Microsoft app
as the GitHub jobs). Without them it does nothing, and calldesk_sheet_sync.py (GitHub, 3x a day + morning)
writes the lines later. Same rules as calldesk_sheet_sync.py: lines are added through the Excel web API
(the open workbooks are not replaced), a number / pet already in the sheet is not added again.
"""
import base64
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
from _supabase import call_rpc, read_cookie, send  # noqa: E402

GRAPH = "https://graph.microsoft.com/v1.0"
DND_URL = os.environ.get("DND_SHEET_URL") or \
    "https://sanchuhospital-my.sharepoint.com/:x:/g/personal/shenbagaraj_sanchu_co_in/IQCCCrtOGOh4RIBs9FwKvN-PARonVvnuxGoOttA8JFFVsGc"
DND_SHEET = "DND"
DEC_HOST = "sanchuhospital-my.sharepoint.com"
DEC_SITE_PATH = "/personal/sanchureports_sanchu_co_in"
DEC_ITEM = os.environ.get("SP_DECEASED_ITEM_ID") or "01DIVYIDHTXAGQL34EVZGKQYRBPS7D7ANV"
DEC_SHEET = "Deceased Data"


def http(method, url, token=None, body=None, headers=None, form=None):
    h = dict(headers or {})
    if token:
        h["Authorization"] = f"Bearer {token}"
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url.split('?')[0][-60:]} -> {e.code} {e.read()[:200]!r}")


def graph_token():
    t = os.environ["SP_TENANT_ID"]
    _, j = http("POST", f"https://login.microsoftonline.com/{t}/oauth2/v2.0/token", form={
        "client_id": os.environ["SP_CLIENT_ID"], "client_secret": os.environ["SP_CLIENT_SECRET"],
        "scope": "https://graph.microsoft.com/.default", "grant_type": "client_credentials"})
    return j["access_token"]


def used(tok, base, sheet, formulas=False):
    sel = "address,values,formulas" if formulas else "address,values"
    vo = "" if formulas else "(valuesOnly=true)"
    _, j = http("GET", f"{base}/worksheets('{urllib.parse.quote(sheet)}')/usedRange{vo}?$select={sel}", tok)
    return j


def last_row(u):
    first = int(re.search(r"!([A-Z]+)(\d+)", u["address"]).group(2))
    vals = u.get("values") or []
    n = len(vals)
    while n > 0 and all(v in (None, "") for v in vals[n - 1]):
        n -= 1
    return first + n - 1


def phone10(v):
    d = re.sub(r"\D", "", str(int(v) if isinstance(v, float) else v))
    return d[-10:] if len(d) >= 10 else None


def write_dnd(tok, items):
    share = "u!" + base64.urlsafe_b64encode(DND_URL.encode()).decode().rstrip("=")
    _, it = http("GET", f"{GRAPH}/shares/{share}/driveItem", tok)
    base = f"{GRAPH}/drives/{it['parentReference']['driveId']}/items/{it['id']}/workbook"
    u = used(tok, base, DND_SHEET)
    have = {phone10(r[0]) for r in (u.get("values") or [])[1:] if r and r[0] not in (None, "")}
    todo = [x for x in items if phone10(x["phone"]) and phone10(x["phone"]) not in have]
    if todo:
        start = last_row(u) + 1
        f = [[int(phone10(x["phone"])), f"{x['note']} (Call Desk)", f"=RIGHT(A{start + i},10)*1"] for i, x in enumerate(todo)]
        http("PATCH", f"{base}/worksheets('{DND_SHEET}')/range(address='A{start}:C{start + len(todo) - 1}')", tok, {"formulas": f})
    return [x["phone"] for x in items]


def vb_text(d):
    return dt.date.fromisoformat(d).strftime("%d, %b %y") if d else ""


def write_deceased(tok, items):
    _, site = http("GET", f"{GRAPH}/sites/{DEC_HOST}:{DEC_SITE_PATH}", tok)
    _, drive = http("GET", f"{GRAPH}/sites/{site['id']}/drive", tok)
    base = f"{GRAPH}/drives/{drive['id']}/items/{DEC_ITEM}/workbook"
    u = used(tok, base, DEC_SHEET, formulas=True)
    vals, fr = u.get("values") or [], u.get("formulas") or []
    head = [str(x).strip() for x in vals[0]]
    col = {re.sub(r"[^a-z]", "", x.lower()): i for i, x in enumerate(head)}
    for k in ("patientid", "patient", "firstactive", "lastactive", "clientname", "species", "breed", "status"):
        if k not in col:
            raise RuntimeError(f"Deceased sheet header changed: {head}")
    have = {str(r[col["patientid"]]).split(".")[0] for r in vals[1:] if r and r[col["patientid"]] not in (None, "")}
    lr = last_row(u)
    first = int(re.search(r"!([A-Z]+)(\d+)", u["address"]).group(2))
    lastf = fr[lr - first] if lr - first < len(fr) else []
    lines = []
    for x in items:
        if str(x["pet_id"]) in have:
            continue
        r = lr + 1 + len(lines)
        line = [""] * len(head)
        for ci, f in enumerate(lastf):
            if isinstance(f, str) and f.startswith("="):
                line[ci] = re.sub(r"([A-Z]{1,3})%d\b" % lr, lambda m: f"{m.group(1)}{r}", f)
        pid = str(x["pet_id"])
        line[col["patientid"]] = int(pid) if pid.isdigit() else pid
        line[col["patient"]] = x.get("pet_name") or ""
        line[col["firstactive"]] = vb_text(x.get("first_active"))
        line[col["lastactive"]] = vb_text(x.get("last_active"))
        line[col["clientname"]] = x.get("client_name") or ""
        line[col["species"]] = x.get("species") or ""
        line[col["breed"]] = x.get("breed") or ""
        line[col["status"]] = f"Deceased (Call Desk - {x.get('by') or ''})"
        lines.append(line)
    if lines:
        last_col = re.search(r"!([A-Z]+)\d+:([A-Z]+)\d+$", u["address"]).group(2)
        http("PATCH", f"{base}/worksheets('{urllib.parse.quote(DEC_SHEET)}')/range(address='A{lr + 1}:{last_col}{lr + len(lines)}')",
             tok, {"formulas": lines})
    return [str(x["pet_id"]) for x in items]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        """Health check: are the Microsoft keys set and do they sign in? (no data shown)"""
        keys = all(os.environ.get(k) for k in ("SP_TENANT_ID", "SP_CLIENT_ID", "SP_CLIENT_SECRET"))
        res = {"keys_set": keys}
        if keys:
            try:
                tok = graph_token()
                http("GET", f"{GRAPH}/sites/{DEC_HOST}:{DEC_SITE_PATH}?$select=id", tok)
                res["microsoft"] = "ok"
            except Exception as e:  # noqa: BLE001
                res["microsoft"] = re.sub(r"[A-Za-z0-9_\-~.]{30,}", "...", str(e))[:200]
        send(self, 200, res)

    def do_POST(self):
        token = read_cookie(self)
        if not token:
            return send(self, 401, {"message": "signed out"})
        if not all(os.environ.get(k) for k in ("SP_TENANT_ID", "SP_CLIENT_ID", "SP_CLIENT_SECRET")):
            return send(self, 200, {"written": False, "why": "Microsoft keys not set - the scheduled sync writes the lines"})
        st, raw = call_rpc("cd_sheet_pending", {}, token)
        if st != 200:
            return send(self, st, raw)
        todo = json.loads(raw or b"{}")
        if not todo.get("dnd") and not todo.get("deceased"):
            return send(self, 200, {"written": True, "dnd": 0, "deceased": 0, "errors": []})   # nothing waiting
        out, errors = {"dnd": [], "pets": []}, []
        try:
            tok = graph_token()
        except Exception as e:  # noqa: BLE001
            return send(self, 200, {"written": False, "why": f"Microsoft sign-in failed: {e}"})
        if todo.get("dnd"):
            try:
                out["dnd"] = write_dnd(tok, todo["dnd"])
            except Exception as e:  # noqa: BLE001
                errors.append(f"DND sheet: {e}")
        if todo.get("deceased"):
            try:
                out["pets"] = write_deceased(tok, todo["deceased"])
            except Exception as e:  # noqa: BLE001
                errors.append(f"Deceased sheet: {e}")
        if out["dnd"] or out["pets"]:
            call_rpc("cd_sheet_done", {"p_phones": out["dnd"], "p_pets": out["pets"]}, token)
        send(self, 200, {"written": True, "dnd": len(out["dnd"]), "deceased": len(out["pets"]), "errors": errors})
