#!/usr/bin/env python3
"""Read only: where is "Deceased Pets Data.xlsx", who changed it last, and its versions."""
import sys, requests
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vetbuddy_sales_export as vb, vetbuddy_deceased_export as dx
from urllib.parse import quote
h = {"Authorization": f"Bearer {vb.graph_token()}"}
drive = vb.sp_drive(h, dx.SITE, dx.LIBRARY)
print("drive", drive["id"][:12], drive.get("webUrl"))
r = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/root/search(q='{quote(dx.MASTER_NAME)}')", headers=h, timeout=60).json()
for i in r.get("value", []):
    print("search hit:", i["name"], i.get("id"), "driveId", (i.get("parentReference") or {}).get("driveId", "")[:12],
          "path", (i.get("parentReference") or {}).get("path"), "size", i.get("size"), "modified", i.get("lastModifiedDateTime"),
          "by", ((i.get("lastModifiedBy") or {}).get("user") or {}).get("displayName"), "remote", bool(i.get("remoteItem")))
p = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/root:/{quote(dx.MASTER_NAME)}", headers=h, timeout=60)
print("by path:", p.status_code, p.json().get("id") if p.ok else p.text[:200], p.json().get("size") if p.ok else "",
      p.json().get("lastModifiedDateTime") if p.ok else "", ((p.json().get("lastModifiedBy") or {}).get("user") or {}).get("displayName") if p.ok else "")
if p.ok:
    v = requests.get(f"{vb.GRAPH}/drives/{drive['id']}/items/{p.json()['id']}/versions", headers=h, timeout=60).json()
    for x in v.get("value", [])[:12]:
        print("  version", x.get("id"), x.get("lastModifiedDateTime"), x.get("size"), ((x.get("lastModifiedBy") or {}).get("user") or {}).get("displayName"))
