#!/usr/bin/env python3
"""Read only: the team's DND workbook (shared link) - sheets, the DND sheet's header and last rows (phones masked)."""
import base64, io, os, re, sys, requests, openpyxl
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vetbuddy_sales_export as vb
URL = os.environ["DND_URL"]
h = {"Authorization": f"Bearer {vb.graph_token()}"}
tok = "u!" + base64.urlsafe_b64encode(URL.encode()).decode().rstrip("=")
it = requests.get(f"{vb.GRAPH}/shares/{tok}/driveItem", headers=h, timeout=60)
print("share:", it.status_code, it.text[:300] if not it.ok else "")
it = it.json()
print("file:", it.get("name"), "drive", it["parentReference"]["driveId"][:12], "item", it["id"], "size", it.get("size"),
      "modified", it.get("lastModifiedDateTime"), "by", ((it.get("lastModifiedBy") or {}).get("user") or {}).get("displayName"))
data = requests.get(f"{vb.GRAPH}/drives/{it['parentReference']['driveId']}/items/{it['id']}/content", headers=h, timeout=120).content
wb = openpyxl.load_workbook(io.BytesIO(data))
mask = lambda v: re.sub(r"\d(?=\d{4})", "x", str(v)) if v is not None else ""
for ws in wb.worksheets:
    print(f"sheet '{ws.title}': {ws.max_row} rows x {ws.max_column} cols, tables {list(ws.tables.keys())}")
    if "dnd" in ws.title.lower():
        for r in range(1, min(ws.max_row, 3) + 1):
            print("  row", r, [mask(c.value) for c in ws[r]][:15])
        last = ws.max_row
        while last > 1 and all(c.value in (None, "") for c in ws[last]):
            last -= 1
        for r in range(max(1, last - 4), last + 1):
            print("  row", r, [(mask(c.value), c.number_format) for c in ws[r]][:10])
