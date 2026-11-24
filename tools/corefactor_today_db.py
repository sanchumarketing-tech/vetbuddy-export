"""Load TODAY's Corefactor call-log export into the Call Desk database only (24 Nov 2026).

For a gap in the live webhook (e.g. calls made before the webhook started). Nothing is written to SharePoint
(the archive / master keep getting the full day the next morning, as before). Export rows replace the live copies
of the same calls (calldesk.cf_live_dedup), then today's list rows are re-marked (calldesk.refresh_status).
No phone numbers are printed.
"""
import datetime as dt
import logging
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import corefactor_calllogs_export as cf   # noqa: E402
import calldesk_load as cl                # noqa: E402
import reminder_calls_check as rc         # noqa: E402
import vetbuddy_sql                       # noqa: E402

log = logging.getLogger("vetbuddy")


def main():
    cf.setup_logging()
    day = dt.datetime.now(cf.IST).date()
    c = cf.Corefactor(cf.env("COREFACTOR_BASE_URL", "https://tw1.teleduce.corefactors.in"),
                      cf.env("COREFACTOR_SESSIONID", required=True))
    c.open_call_logs()
    name = f"CallLogs_{day.isoformat()}_calldesk_{dt.datetime.now(cf.IST):%H%M%S}"
    c.request_export(day, name)
    fname, raw, _, _ = cf.read_export(c.download(c.wait_for_export(name, 20 * 60)))
    seen, rows = Counter(), []
    for r in rc.read_table(fname, raw):
        line = cl.corefactor_line(r, seen)
        if line:
            rows.append(line)
    log.info("Export for %s: %d calls", day, len(rows))
    if not rows:
        return 1
    with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
        cl.insert_calls(cur, rows, day, day)
        cur.execute("select calldesk.refresh_status(%s)", (day,))
        log.info("List rows re-marked: %s", cur.fetchone()[0])
        conn.commit()
    return 0


if __name__ == "__main__":
    sys.exit(main())
