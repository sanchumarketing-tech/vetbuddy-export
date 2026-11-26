#!/usr/bin/env python3
"""Hand-over: copy one file from the reports OneDrive (SP_CALLLOG_SITE_URL) into calldesk.tmp_export so it can be
picked up in the chat; the row is deleted right after. Logs only the file name and size."""
import os, sys
from pathlib import Path
from urllib.parse import quote
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import vetbuddy_sales_export as vx  # noqa: E402
import vetbuddy_sql as vs  # noqa: E402

path = os.environ["FILE_PATH"].strip("/")
h = {"Authorization": f"Bearer {vx.graph_token()}"}
drive = vx.sp_drive(h, os.environ.get("SP_CALLLOG_SITE_URL", ""), os.environ.get("SP_CALLLOG_LIBRARY", "Documents"))
r = requests.get(f"{vx.GRAPH}/drives/{drive['id']}/root:/{quote(path)}:/content", headers=h, timeout=300)
vx._check(r, f"Downloading {path}")
con = vs.connect()
with con.cursor() as c:
    c.execute("insert into calldesk.tmp_export (name, data) values (%s, %s) on conflict (name) do update set data = excluded.data, made_at = now()",
              (path.split("/")[-1], r.content))
con.commit(); con.close()
vx.log.info("Stored %s (%d KB) for hand-over", path.split("/")[-1], len(r.content) // 1024)
