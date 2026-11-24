"""
send_to_hub.py — sends report files to the MIS Upload Hub (automatic upload).

Used by the daily VetBuddy GitHub job, after it has downloaded the VetBuddy export:
    python send_to_hub.py path/to/vetbuddy_export.xls [more files …]

Needs two environment variables (GitHub secrets):
    HUB_URL  — the hub's web app link (hub Settings → B3, ends in /exec)
    HUB_KEY  — the automatic upload key (hub Settings → B5)

The hub recognises each file from its columns, keeps only the columns each MIS needs and sends it to
every MIS on the Report Types “Send to” list (SM Calling sheets, Google performance, …).
Exits with an error (so the GitHub run turns red and emails you) if the hub reports a problem.
"""
import datetime as dt
import json
import math
import os
import sys

import pandas as pd
import requests


def read_sheets(path):
    """Every sheet of the file as a list of rows (all cells as text, dates as yyyy-mm-dd)."""
    low = path.lower()
    frames = {}
    if low.endswith(".csv"):
        frames[""] = pd.read_csv(path, header=None, dtype=object)
    else:
        try:
            frames = pd.read_excel(path, sheet_name=None, header=None, dtype=object)
        except Exception:
            # some “.xls” exports are really HTML tables
            tables = pd.read_html(path, header=None)
            frames = {f"Table{i + 1}": t for i, t in enumerate(tables)}
    out = []
    for name, df in frames.items():
        rows = [[cell(v) for v in r] for r in df.itertuples(index=False)]
        out.append({"sheet": str(name), "rows": rows})
    return out


def cell(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    if isinstance(v, (pd.Timestamp, dt.datetime)):
        return v.strftime("%Y-%m-%d") if (v.hour, v.minute, v.second) == (0, 0, 0) else v.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(v, dt.date):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def main(paths):
    url, key = os.environ.get("HUB_URL", "").strip(), os.environ.get("HUB_KEY", "").strip()
    if not url or not key:
        sys.exit("HUB_URL / HUB_KEY secrets are missing.")
    files = [{"name": os.path.basename(p), "sheets": read_sheets(p)} for p in paths]
    body = json.dumps({"key": key, "source": "GitHub job", "files": files})
    print(f"Sending {len(files)} file(s), {len(body) / 1e6:.1f} MB, to the hub …")
    r = requests.post(url, data=body, headers={"Content-Type": "application/json"}, timeout=600, allow_redirects=True)
    try:
        res = r.json()
    except ValueError:
        sys.exit(f"Hub reply was not understood (HTTP {r.status_code}): {r.text[:300]}")
    print(res.get("message", ""))
    for x in res.get("results", []):
        print(("OK   " if x.get("ok") else "FAIL ") + x.get("mis", "") + " — " + x.get("message", ""))
    if not res.get("ok"):
        sys.exit("The hub reported a problem (see above).")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python send_to_hub.py <file> [file …]")
    main(sys.argv[1:])
