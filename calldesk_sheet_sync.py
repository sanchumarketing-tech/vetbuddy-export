#!/usr/bin/env python3
"""
Call Desk <-> the team's sheets (23 Nov 2026). Runs with the Call Desk log (3 times a day) and the morning
deceased job. Writes in place through the Excel web API (the sheets stay open for the team - no file rewrite).

1. DND sheet in  ("Backend Call Centre Details.xlsx", sheet DND: Phone Number | Reason | Ct.no):
   every number there is never called by the Call Desk (calldesk.exclusions, reason 'dnd').
2. DND sheet out: numbers the agents put on DND (button / "Do not call") are added as new lines:
   phone, the agent's reason, =RIGHT(A,10)*1 - like the team's own lines.
3. Deceased out: pets the agents ticked "Deceased" are added as new lines to "Deceased Pets Data.xlsx"
   (sheet "Deceased Data"): Patient ID, Patient, First/Last Active when known, Client Name, Species, Breed,
   Status "Deceased (Call Desk - <agent>)". The morning month-to-date rewrite keeps these lines.
Written lines are stamped (sheet_at), so nothing is written twice. Phone numbers are never printed.
"""
import base64
import datetime as dt
import logging
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vetbuddy_sales_export as vb   # noqa: E402  Graph token
import vetbuddy_sql                  # noqa: E402  database

log = logging.getLogger("sheet-sync")
DND_URL = os.environ.get("DND_SHEET_URL") or \
    "https://sanchuhospital-my.sharepoint.com/:x:/g/personal/shenbagaraj_sanchu_co_in/IQCCCrtOGOh4RIBs9FwKvN-PARonVvnuxGoOttA8JFFVsGc"
DND_SHEET = os.environ.get("DND_SHEET_NAME") or "DND"
DEC_SITE = os.environ.get("SP_DECEASED_SITE_URL") or "https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in"
DEC_ITEM = os.environ.get("SP_DECEASED_ITEM_ID") or "01DIVYIDHTXAGQL34EVZGKQYRBPS7D7ANV"
DEC_SHEET = os.environ.get("SP_DECEASED_SHEET") or "Deceased Data"
CALLDESK_STATUS = "Deceased (Call Desk"          # the month-to-date rewrite keeps lines whose Status starts so


def phone10(v):
    d = re.sub(r"\D", "", str(v if not isinstance(v, float) else int(v)))
    return d[-10:] if len(d) >= 10 and d[-10] in "6789" else None


class Book:
    """One workbook through the Excel web API, in a session that saves (persistChanges)."""
    def __init__(self, h, drive_id, item_id):
        self.h = dict(h)
        self.base = f"{vb.GRAPH}/drives/{drive_id}/items/{item_id}/workbook"
        r = self.req("POST", "/createSession", json={"persistChanges": True})
        self.h["workbook-session-id"] = r.json()["id"]

    def req(self, method, path, **kw):
        for i in range(4):
            r = requests.request(method, self.base + path, headers=self.h, timeout=120, **kw)
            if r.status_code in (429, 503, 504) or (r.status_code == 409 and i < 3):
                time.sleep(5 * (i + 1))
                continue
            vb._check(r, f"Excel {method} {path[:60]}")
            return r
        vb._check(r, f"Excel {method} {path[:60]}")
        return r

    def used(self, sheet):
        return self.req("GET", f"/worksheets('{quote(sheet)}')/usedRange(valuesOnly=true)?$select=address,values").json()

    def write(self, sheet, address, formulas):
        return self.req("PATCH", f"/worksheets('{quote(sheet)}')/range(address='{address}')", json={"formulas": formulas})

    def close(self):
        try:
            requests.post(self.base + "/closeSession", headers=self.h, timeout=60)
        except requests.RequestException:
            pass


def last_row(used):
    """Row number of the last line with something in it (from a usedRange answer)."""
    m = re.search(r"!([A-Z]+)(\d+)(?::[A-Z]+(\d+))?$", used["address"])
    first = int(m.group(2))
    vals = used.get("values") or []
    n = len(vals)
    while n > 0 and all(v in (None, "") for v in vals[n - 1]):
        n -= 1
    return first + n - 1


def sync_dnd(h, cur):
    tok = "u!" + base64.urlsafe_b64encode(DND_URL.encode()).decode().rstrip("=")
    r = requests.get(f"{vb.GRAPH}/shares/{tok}/driveItem", headers=h, timeout=60)
    vb._check(r, "Opening the DND sheet link")
    it = r.json()
    bk = Book(h, it["parentReference"]["driveId"], it["id"])
    try:
        used = bk.used(DND_SHEET)
        vals = used.get("values") or []
        head = [str(x).strip().lower() for x in (vals[0] if vals else [])]
        if not head or "phone" not in head[0] or "reason" not in (head[1] if len(head) > 1 else ""):
            raise RuntimeError(f"DND sheet header changed: {vals[:1]} - nothing done")
        in_sheet = {}
        for row in vals[1:]:
            p = phone10(row[0]) if row else None
            if p:
                in_sheet[p] = str(row[1]).strip() if len(row) > 1 and row[1] not in (None, "") else "DND"
        # 1. sheet -> Call Desk (switched on with DND_IMPORT=1)
        cur.execute("select phone from calldesk.exclusions")
        known = {p for (p,) in cur.fetchall()}
        new_in = [(p, reason) for p, reason in in_sheet.items() if p not in known]
        cur.execute("""select count(distinct phone) from calldesk.queue where list_date >= calldesk.today() and phone = any(%s)""",
                    ([p for p, _ in new_in],))
        log.info("DND sheet: %d numbers not yet blocked in the Call Desk (%d of them are on today's/later lists)",
                 len(new_in), cur.fetchone()[0])
        if os.environ.get("DND_IMPORT") != "1":
            new_in = []
        if new_in:
            cur.executemany("""insert into calldesk.exclusions (phone, reason, note, added_by, sheet_at)
                               values (%s, 'dnd', %s, 'DND sheet', now()) on conflict (phone) do nothing""", new_in)
            cur.execute("select calldesk.exclusions_clean()")
        # 2. Call Desk -> sheet
        cur.execute("""select phone, coalesce(nullif(note, ''), 'DND') from calldesk.exclusions
                        where reason = 'dnd' and sheet_at is null and coalesce(added_by, '') <> 'DND sheet'
                        order by added_at""")
        out = [(p, n) for p, n in cur.fetchall() if phone10(p)]
        already = [p for p, _ in out if p in in_sheet]
        todo = [(p, n) for p, n in out if p not in in_sheet]
        if todo:
            start = last_row(used) + 1
            end = start + len(todo) - 1
            bk.write(DND_SHEET, f"A{start}:C{end}",
                     [[int(p), f"{n} (Call Desk)", f"=RIGHT(A{start + i},10)*1"] for i, (p, n) in enumerate(todo)])
        if out:
            cur.execute("update calldesk.exclusions set sheet_at = now() where phone = any(%s)", ([p for p, _ in out],))
        log.info("DND sheet: %d numbers in the sheet; %d new ones now blocked in the Call Desk; %d Call Desk DND numbers added "
                 "to the sheet (%d were already there)", len(in_sheet), len(new_in), len(todo), len(already))
    finally:
        bk.close()


def vb_text(d):
    """VetBuddy's date text: '07, Nov 26'."""
    return d.strftime("%d, %b %y") if d else None


def sync_deceased(h, cur):
    cur.execute("""select m.pet_id, m.pet_name, m.first_active, m.last_active, m.client_name, m.species, m.breed, m.marked_by
                     from calldesk.deceased_marked m where m.sheet_at is null order by m.marked_at""")
    rows = cur.fetchall()
    if not rows:
        log.info("Deceased sheet: no new Call Desk marks")
        return
    drive = vb.sp_drive(h, DEC_SITE, "Documents")
    bk = Book(h, drive["id"], DEC_ITEM)
    try:
        used = bk.req("GET", f"/worksheets('{quote(DEC_SHEET)}')/usedRange?$select=address,values,formulas").json()
        vals = used.get("values") or []
        fr = used.get("formulas") or []
        head = [str(x).strip() for x in vals[0]]
        lr = last_row(used)
        first = int(re.search(r"!([A-Z]+)(\d+)", used["address"]).group(2))
        lastf = fr[lr - first] if fr and lr - first < len(fr) else []
        col = {re.sub(r"[^a-z]", "", x.lower()): i for i, x in enumerate(head)}
        need = ["patientid", "patient", "firstactive", "lastactive", "clientname", "species", "breed", "status"]
        if any(k not in col for k in need):
            raise RuntimeError(f"Deceased sheet header changed: {head} - nothing done")
        have = {str(r[col["patientid"]]).split(".")[0] for r in vals[1:] if r and r[col["patientid"]] not in (None, "")}
        lines, done = [], []
        for pid, name, fa, la, client, sp, br, by in rows:
            done.append(pid)
            if str(pid) in have:
                continue                                   # already in the sheet (VetBuddy line)
            line = [""] * len(head)
            for ci, f in enumerate(lastf):                 # formula columns: the last line's formula, moved down
                if isinstance(f, str) and f.startswith("="):
                    line[ci] = ("ROW", f)
            line[col["patientid"]] = int(pid) if str(pid).isdigit() else pid
            line[col["patient"]] = name or ""
            line[col["firstactive"]] = vb_text(fa) or ""
            line[col["lastactive"]] = vb_text(la) or ""
            line[col["clientname"]] = client or ""
            line[col["species"]] = sp or ""
            line[col["breed"]] = br or ""
            line[col["status"]] = f"{CALLDESK_STATUS} - {(by or '').split('@')[0]})"
            lines.append(line)
        if lines:
            start = lr + 1
            for k, line in enumerate(lines):
                for ci, v in enumerate(line):
                    if isinstance(v, tuple):
                        line[ci] = re.sub(r"([A-Z]{1,3})%d\b" % lr, lambda m, r=start + k: f"{m.group(1)}{r}", v[1])
            last_col = re.search(r"!([A-Z]+)\d+:([A-Z]+)\d+$", used["address"]).group(2)
            bk.write(DEC_SHEET, f"A{start}:{last_col}{start + len(lines) - 1}", lines)
        cur.execute("update calldesk.deceased_marked set sheet_at = now() where pet_id = any(%s)", (done,))
        log.info("Deceased sheet: %d pets marked in the Call Desk added as new lines (%d were already in the sheet)",
                 len(lines), len(done) - len(lines))
    finally:
        bk.close()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
    h = {"Authorization": f"Bearer {vb.graph_token()}"}
    bad = 0
    for name, fn in (("DND", sync_dnd), ("Deceased", sync_deceased)):
        try:
            with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
                fn(h, cur)
                conn.commit()
        except Exception as e:  # noqa: BLE001  one sheet failing does not stop the other
            bad += 1
            log.error("%s sheet sync failed: %s", name, e)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
