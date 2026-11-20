#!/usr/bin/env python3
"""
Call Desk log -> SharePoint Excel ("Sanchu Reports/Call Desk Log.xlsx" in the sanchureports OneDrive).

One row per customer on an agent's list: date, agent, customer, phone, unit, reason, status
(Called / Not called / Rescheduled), rescheduled date and time, when it was marked called and by whom,
the agent's note, and what the Corefactor / Runo logs say. One sheet per month (newest first) plus
"Today". Runs 3 times a day - 1 PM, 6 PM, 10:15 PM (GitHub workflow calldesk-log.yml); only reads the database.
"""
import datetime as dt
import io
import logging
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import corefactor_calllogs_export as cf   # noqa: E402  SharePoint helper
import reminder_calls_check as rc         # noqa: E402  env()
import vetbuddy_sql                       # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("calldesk-log")
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
COLS = ["Date", "Agent", "Customer", "Phone", "Unit", "Reason", "Status", "Rescheduled to", "Marked called at",
        "Marked by", "Note", "Call log: called", "Call log: answered", "Last logged call"]
WIDTH = [11, 16, 24, 12, 14, 70, 12, 19, 19, 16, 30, 10, 10, 42]

SQL = """
select q.list_date, coalesce(a.name, '(not assigned)'), q.client, q.phone, q.unit,
       (select string_agg(e->>'label', ' | ' order by (e->>'rank')::int) from jsonb_array_elements(calldesk.strip_off(q.reasons)) e),
       case when q.outcome = 'callback' and q.callback_at is not null then 'Rescheduled'
            when q.called_at is not null then 'Called' else 'Not called' end,
       q.callback_at at time zone 'Asia/Kolkata', q.called_at at time zone 'Asia/Kolkata', q.called_by, q.note,
       q.attempted_at is not null, q.connected_at is not null, q.last_call
from calldesk.queue q left join calldesk.agents a on a.id = q.agent_id
where q.list_date >= %s and not q.superseded and calldesk.row_visible(q)   -- same rows the agents see (reasons switched off / omitted numbers hidden)
order by q.list_date desc, 2, q.rank, q.id
"""


def clean(s):
    import re
    return re.sub(r"\s+", " ", re.sub(r"&nbsp;?|\s*\(\d+\)", " ", s or "")).strip()


def main():
    today = dt.datetime.now(IST).date()
    first = (today.replace(day=1) - dt.timedelta(days=1)).replace(day=1)       # this month and last month
    with vetbuddy_sql.connect() as conn, conn.cursor() as cur:
        cur.execute(SQL, (first,))
        rows = cur.fetchall()
    log.info("%d rows since %s", len(rows), first)

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    wb.remove(wb.active)
    fill = {"Called": "E2EFDA", "Rescheduled": "EDE7F6", "Not called": "FDE9D9"}

    def sheet(title, data):
        ws = wb.create_sheet(title)
        ws.append(COLS)
        for c in ws[1]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="1F3864")
            c.alignment = Alignment(wrap_text=True, vertical="center")
        for r in data:
            ws.append([r[0], r[1], clean(r[2]).title(), r[3], (r[4] or "").title(), clean(r[5]), r[6], r[7], r[8],
                       r[9] or "", r[10] or "", "Yes" if r[11] else "No", "Yes" if r[12] else "No", r[13] or ""])
            ws.cell(ws.max_row, 7).fill = PatternFill("solid", fgColor=fill[r[6]])
        for i, w in enumerate(WIDTH, 1):
            ws.column_dimensions[ws.cell(1, i).column_letter].width = w
        for row in ws.iter_rows(min_row=2):
            row[0].number_format = "dd-mm-yyyy"
            row[7].number_format = row[8].number_format = "dd-mm-yyyy hh:mm AM/PM"
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions

    sheet("Today", [r for r in rows if r[0] == today])
    months = sorted({(r[0].year, r[0].month) for r in rows}, reverse=True)
    for y, m in months:
        sheet(dt.date(y, m, 1).strftime("%b %Y"), [r for r in rows if (r[0].year, r[0].month) == (y, m)])
    buf = io.BytesIO()
    wb.save(buf)

    sp = cf.SharePoint.from_env("SP_REMINDER_SITE_URL", "SP_REMINDER_LIBRARY")
    path = rc.env("SP_CALLDESK_LOG_PATH", "Sanchu Reports/Call Desk Log.xlsx")
    try:
        sp.upload(path, buf.getvalue())
    except cf.FileLocked:
        # someone has the file open in Excel / the browser: skip this hour, the next run writes it
        log.warning("%s is open (locked) - not updated this hour; the next run will update it", path)
        return 0
    t = [r for r in rows if r[0] == today]
    log.info("Uploaded %s - today: %d rows, %d called, %d rescheduled, %d not called", path, len(t),
             sum(r[6] == "Called" for r in t), sum(r[6] == "Rescheduled" for r in t), sum(r[6] == "Not called" for r in t))
    return 0


if __name__ == "__main__":
    sys.exit(main())
