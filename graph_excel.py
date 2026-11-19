#!/usr/bin/env python3
"""
Append rows to a big Excel master on SharePoint / OneDrive WITHOUT downloading it (19 Nov 2026).

The old way (openpyxl) downloads the whole workbook, opens it, appends and uploads it again - about
20 minutes each way for Backend Leadbox Report.xlsx. Here the Excel service of Microsoft Graph writes the
new rows straight into the file where it is:
  * finds the last used row and the header row,
  * checks the new data's headers match the master's (formula columns excepted), as before,
  * knows a day already there by the date columns of the bottom rows (skip / replace-if-last, as before),
  * writes the values below the last row in the master's own formats (dates as dates, text as text),
  * fills the drag-down formula columns ("Date", "Appt Datevalue") with the formula of the row above,
    exactly like dragging it down (R1C1 formulas, so references move with the row),
  * extends an Excel table that ended at the last row.
Everything goes through one workbook session; nothing is written unless the checks pass.
"""
import re
import time
from datetime import date, datetime, time as dtime, timedelta

import requests

import corefactor_calllogs_export as cf

log = cf.log
GRAPH = "https://graph.microsoft.com/v1.0"
EPOCH = datetime(1899, 12, 30)


def col_letter(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def to_serial(v):
    if isinstance(v, datetime):
        return (v - EPOCH).total_seconds() / 86400
    if isinstance(v, date):
        return float((v - EPOCH.date()).days)
    if isinstance(v, dtime):
        return (v.hour * 3600 + v.minute * 60 + v.second) / 86400
    return None


def from_serial(x):
    try:
        return (EPOCH + timedelta(days=float(x))).date()
    except (TypeError, ValueError, OverflowError):
        return None


def is_date_fmt(fmt):
    f = re.sub(r'"[^"]*"|\[[^\]]*\]', "", str(fmt or "")).lower()
    return any(k in f for k in ("d", "y")) and f not in ("general", "@")


def is_time_fmt(fmt):
    f = re.sub(r'"[^"]*"|\[[^\]]*\]', "", str(fmt or "")).lower()
    return ("h" in f or "s" in f) and not is_date_fmt(fmt)


class GraphSheet:
    def __init__(self, sp, path, sheet=None, header_row=1):
        self.sp, self.hr = sp, int(header_row)
        meta = sp._get(sp._item(path)).json()
        self.base = f"{GRAPH}/drives/{sp.drive}/items/{meta['id']}/workbook"
        log.info("Excel service: %s (%.0f MB)", meta.get("name"), (meta.get("size") or 0) / 1e6)
        self.h = dict(sp.h)
        r = self._req("post", "/createSession", json={"persistChanges": True}, timeout=600)
        self.h["workbook-session-id"] = r.json()["id"]
        names = [w["name"] for w in self._req("get", "/worksheets?$select=name").json()["value"]]
        self.ws = sheet if sheet else names[0]
        if self.ws not in names:
            raise cf.RunError(f"Sheet '{self.ws}' not found in the master. Sheets: {names}")
        self.wsu = f"/worksheets('{self.ws}')"
        addr = self._req("get", self.wsu + "/usedRange(valuesOnly=true)?$select=address").json()["address"]
        m = re.search(r"!?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$", addr)
        self.last = int(m.group(4) or m.group(2))
        hdr = self.range(f"A{self.hr}:{m.group(3) or m.group(1)}{self.hr}", "values")["values"][0]
        while hdr and hdr[-1] in (None, ""):
            hdr.pop()
        self.headers = {i + 1: h for i, h in enumerate(hdr) if h not in (None, "")}
        self.ncol = len(hdr)
        self.lastcol = col_letter(self.ncol)
        log.info("Master sheet '%s': %d columns, last row %d", self.ws, self.ncol, self.last)

    # ---------------------------------------------------------------- low level
    def _req(self, method, path, timeout=300, **kw):
        url = path if path.startswith("http") else self.base + path
        for attempt in range(1, 6):
            r = requests.request(method, url, headers=self.h, timeout=timeout, **kw)
            if r.status_code in (429, 503, 504) or (r.status_code == 500 and attempt < 5):
                wait = int(r.headers.get("Retry-After") or 10 * attempt)
                log.warning("Excel service busy (%s), retrying in %ss", r.status_code, wait)
                time.sleep(wait)
                continue
            if r.status_code == 423:
                raise cf.FileLocked()
            if r.status_code >= 400:
                raise cf.RunError(f"Excel service error {r.status_code} on {path[:120]}: {r.text[:400]}")
            return r
        raise cf.RunError(f"Excel service kept failing on {path[:120]}")

    def range(self, address, select="values"):
        return self._req("get", f"{self.wsu}/range(address='{address}')?$select={select}").json()

    def patch(self, address, body):
        self._req("patch", f"{self.wsu}/range(address='{address}')", json=body)

    def close(self):
        try:
            requests.post(self.base + "/closeSession", headers=self.h, timeout=60)
        except requests.RequestException:
            pass

    def col(self, name):
        return next((ci for ci, h in self.headers.items() if cf.norm(h) == cf.norm(name)), None)

    # ---------------------------------------------------------------- days already there
    def days_at_bottom(self, cols, depth=6000):
        """{row: date} for the bottom `depth` rows, from the first of `cols` that has a date."""
        lo = max(self.hr + 1, self.last - depth + 1)
        out = {}
        for ci in [c for c in cols if c]:
            vals = self.range(f"{col_letter(ci)}{lo}:{col_letter(ci)}{self.last}", "values")["values"]
            for k, (v,) in enumerate(vals):
                r = lo + k
                if r in out:
                    continue
                d = from_serial(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 20000 \
                    else cf.as_date(cf.parse_dt(v) if isinstance(v, str) else v)
                if d:
                    out[r] = d
        return out

    # ---------------------------------------------------------------- bottom rows
    def bottom(self):
        """Formats, sample values and drag-down formulas from the bottom 50 rows (read once)."""
        if getattr(self, "_bottom", None) is None:
            look = max(self.hr + 1, self.last - 49)
            block = self.range(f"A{look}:{self.lastcol}{self.last}", "formulasR1C1,numberFormat,values")
            f_rows = block["formulasR1C1"]
            formula = {}
            for ci in self.headers:
                for k in range(len(f_rows) - 1, -1, -1):
                    f = f_rows[k][ci - 1]
                    if isinstance(f, str) and f.startswith("="):
                        formula[ci] = f
                        break
            self._bottom = (formula, block["numberFormat"][-1], block["values"][-1])
        return self._bottom

    def data_header(self):
        """The master's headers without the formula columns, in order (what the new data must have)."""
        formula = self.bottom()[0]
        return [str(self.headers[ci]).strip() for ci in sorted(self.headers) if ci not in formula]

    # ---------------------------------------------------------------- append
    def append(self, export_header, rows, required_formula_cols=()):
        if not rows:
            return 0
        formula, fmt, sample = self.bottom()
        for name in required_formula_cols:
            ci = self.col(name)
            if ci is None or ci not in formula:
                raise cf.RunError(f"No formula found in the '{name}' column of the master sheet to drag down. "
                                  f"Put the formula back in its last row, then re-run.")
        data_cols = sorted(ci for ci in self.headers if ci not in formula)
        master_h = [str(self.headers[ci]).strip() for ci in data_cols]
        export_h = [str(h or "").strip() for h in export_header]
        differ = [k for k in range(max(len(master_h), len(export_h)))
                  if k >= len(master_h) or k >= len(export_h) or cf.norm(master_h[k]) != cf.norm(export_h[k])]
        if differ:
            k = differ[0]
            raise cf.RunError(f"Header check failed - {len(differ)} columns differ (first: master "
                              f"'{master_h[k] if k < len(master_h) else '-'}' vs new data "
                              f"'{export_h[k] if k < len(export_h) else '-'}'). Nothing was added.")
        log.info("Header check passed: all %d columns match the master; formula columns: %s",
                 len(master_h), [self.headers[ci] for ci in formula])
        pos = {ci: k for k, ci in enumerate(data_cols)}

        def cell(ci, raw):
            if raw is None or (isinstance(raw, str) and raw.strip() == ""):
                return ""
            f, s = fmt[ci - 1], sample[ci - 1]
            if is_date_fmt(f) or is_time_fmt(f):
                d = cf.parse_dt(raw) if isinstance(raw, str) else raw
                if is_time_fmt(f) and isinstance(raw, str):
                    d = cf.parse_time(raw) or d
                ser = to_serial(d) if d is not None else None
                return ser if ser is not None else str(raw)
            if isinstance(s, (int, float)) and not isinstance(s, bool) and isinstance(raw, str):
                plain = raw.replace(",", "").strip()
                if cf.NUMBER_RE.fullmatch(plain):
                    x = float(plain)
                    return int(x) if x.is_integer() and "." not in plain else x
            if isinstance(raw, str):
                raw = raw.strip()
                # keep text as text (phone numbers, ids, "=..." ) like the old paste did
                if re.fullmatch(r"[-+=@].*|[\d.,:/ -]+", raw):
                    return "'" + raw
            return raw

        start = self.last + 1
        chunk = 400
        for i in range(0, len(rows), chunk):
            part = rows[i:i + chunk]
            r1, r2 = start + i, start + i + len(part) - 1
            body_vals = []
            for row in part:
                line = []
                for ci in range(1, self.ncol + 1):
                    if ci in formula:
                        line.append(formula[ci])          # R1C1: same as dragging down
                    elif ci in pos:
                        e = pos[ci]
                        line.append(cell(ci, row[e] if e < len(row) else None))
                    else:
                        line.append("")
                body_vals.append(line)
            self.patch(f"A{r1}:{self.lastcol}{r2}", {"formulasR1C1": body_vals,
                                                        "numberFormat": [fmt] * len(part)})
            log.info("  wrote rows %d-%d", r1, r2)
        new_last = start + len(rows) - 1
        # an Excel table that ended at the old last row grows to the new last row
        for t in self._req("get", self.wsu + "/tables?$select=id,name").json().get("value", []):
            a = self._req("get", f"/tables('{t['id']}')/range?$select=address").json()["address"]
            m = re.search(r"([A-Z]+)(\d+):([A-Z]+)(\d+)$", a.replace("$", ""))
            if m and int(m.group(4)) == self.last:
                self._req("post", f"/tables('{t['id']}')/resize",
                          json={"newRange": f"{self.ws}!{m.group(1)}{m.group(2)}:{m.group(3)}{new_last}"})
                log.info("Table '%s' now ends at row %d", t["name"], new_last)
        log.info("Appended %d rows (rows %d-%d) without downloading the workbook", len(rows), start, new_last)
        self.last = new_last
        self._bottom = None
        return len(rows)

    def clear_rows(self, first, last):
        """Empty rows first..last (they must be the last rows), so a day can be written again."""
        self.patch(f"A{first}:{self.lastcol}{last}",
                   {"values": [[""] * self.ncol for _ in range(last - first + 1)]})
        self.last = first - 1
