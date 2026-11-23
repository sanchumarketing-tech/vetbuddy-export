#!/usr/bin/env python3
"""Read-only (23 Nov 2026): find an Excel file on the sanchureports OneDrive by name and print its layout -
path, sheets, header row, number of rows, which columns hold dates and their range. Prints no cell values
other than headers and dates (no names / phones), so the log is safe."""
import io, os, sys, datetime as dt
import requests, openpyxl
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vetbuddy_sales_export as vb

name = sys.argv[1]
site = os.environ.get("SITE") or "https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in"
h = {"Authorization": f"Bearer {vb.graph_token()}"}
drive = vb.sp_drive(h, site, "Documents")
r = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/root/search(q='{name}')", headers=h, timeout=60)
items = [i for i in r.json().get("value", []) if i.get("file") and i["name"].lower().endswith(".xlsx")]
for i in items:
    print("FOUND", i["parentReference"].get("path", "").split("root:")[-1] + "/" + i["name"], f'{i["size"]/1e6:.1f} MB',
          "modified", i["lastModifiedDateTime"])
it = next(i for i in items if i["name"].lower().startswith(name.lower()))
data = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/items/{it['id']}/content", headers=h, timeout=300).content
wb = openpyxl.load_workbook(io.BytesIO(data), read_only=False, data_only=False)
for ws in wb.worksheets:
    print(f"\nSHEET '{ws.title}': {ws.max_row} rows x {ws.max_column} cols; tables: {list(ws.tables.keys())}")
    hdr_row = next(r for r in range(1, 6) if sum(1 for c in ws[r] if c.value not in (None, "")) >= 3)
    hdr = [c.value for c in ws[hdr_row]]
    print("header row", hdr_row)
    for ci, hv in enumerate(hdr, 1):
        col = [ws.cell(r, ci) for r in range(hdr_row + 1, ws.max_row + 1)]
        vals = [c.value for c in col if c.value not in (None, "")]
        dates = [v for v in vals if isinstance(v, (dt.date, dt.datetime))]
        forms = [v for v in vals if isinstance(v, str) and v.startswith("=")]
        kind = "dates %s..%s" % (min(dates), max(dates)) if dates else ("formula e.g. " + forms[-1][:60] if forms else
                                                                         "%d values" % len(vals))
        fmt = col[-1].number_format if col else ""
        print(f"  {ci:2} {str(hv)[:40]:40} {kind}  fmt={fmt}")
    last = max((r for r in range(hdr_row + 1, ws.max_row + 1) if any(c.value not in (None, "") for c in ws[r])), default=hdr_row)
    print("last filled row", last)
