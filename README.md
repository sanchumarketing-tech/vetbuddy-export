# Sanchu Animal Hospital – daily report automation

Fully automatic, in the cloud (GitHub Actions). Nobody's computer needs to be on.
Seven scheduled runs each day pull reports from VetBuddy, Gofrugal, Corefactor and Runo and put them
in SharePoint / OneDrive (daily files + master workbooks) and in a Supabase database for the Teams bot.

```
06:47 AM IST  VetBuddy  ──► report "Detailed Goods & Services usage by Patients", 1st of month → yesterday, all clinics
                         ├─► .xlsx (title + summary rows removed) ──► SharePoint: CRM Upload
                         ├─► Master "Vetbuddy Master Data 2.xlsx":  this month's rows replaced,
                         │      AX = date,  AY = "VOW Unit" (Vet on Wheels flag)
                         └─► Supabase database (for the Teams bot), same rows + VOW split
              Gofrugal  ──► pharmacy sales + returns, 1st of month → yesterday, all shops
                         ├─► .xlsx ──► SharePoint: Gofrugal Upload
                         └─► Supabase database, with the Vet on Wheels split
06:53 AM IST  Corefactor call logs ──► yesterday's calls appended to "Backend Call Log Report.xlsx"
                                     + day's file in Call Log Archive
07:03 AM IST  Corefactor Lead Box  ──► leads created yesterday appended to "Backend Leadbox Report.xlsx"
                                     + day's file in Lead Box Archive
07:13 AM IST  Runo call logs       ──► month to date ──► Runo Upload + "Runo CallLog.xlsx" (this month replaced)
07:23 AM IST  VetBuddy Appointment Status ──► yesterday's appointments appended to "Appointment Status.xlsx"
                                     + day's file in Appointment Status Archive
01:01 PM IST  VetBuddy Appointment Status ──► TODAY's appointments as at 1 PM appended to the
                                     "Next day" sheet of the same workbook
11:47 PM IST  CRM Upload ──► CRM Archive,  Gofrugal Upload ──► Gofrugal Archive
```
The month-to-date runs (VetBuddy, Gofrugal, Runo) take the **whole previous month** on the 1st,
so the last day of a month is never missed. GitHub may start a scheduled run a few minutes late.

---

## Files

| File | What it does |
|---|---|
| `vetbuddy_sales_export.py` | Main VetBuddy script: login & report, .xlsx, SharePoint upload, archive, Gofrugal step, backfills |
| `master_sheet.py` | Updates the VetBuddy master workbook (60 MB, 300k rows) without opening it in Excel |
| `vow.py` | **Vet on Wheels rules – the one place to change them** (VetBuddy and pharmacy) |
| `vetbuddy_sql.py` | Loads VetBuddy and pharmacy rows into Supabase (daily + one-time backfill) |
| `gofrugal.py` | Downloads Gofrugal pharmacy sales (report 3111) and returns (report 3126) |
| `corefactor_calllogs_export.py` | Corefactor call logs **and the shared code** (SharePoint, master sheets) used by the Lead Box and Runo scripts |
| `corefactor_leadbox_export.py` | Corefactor Lead Box (small file – uses the shared code above) |
| `runo_calllogs_export.py` | Runo call logs through Runo's API |
| `vetbuddy_appointments_export.py` | VetBuddy Appointment Status (uses the VetBuddy login and SharePoint code of `vetbuddy_sales_export.py`) |
| `.github/workflows/vetbuddy-daily.yml` | VetBuddy + Gofrugal schedule (6:47 AM / 11:47 PM IST) and **Run workflow** button |
| `.github/workflows/corefactor-daily.yml` | Call logs schedule (6:53 AM IST) |
| `.github/workflows/leadbox-daily.yml` | Lead Box schedule (7:03 AM IST) |
| `.github/workflows/runo-daily.yml` | Runo schedule (7:13 AM IST) |
| `.github/workflows/appointments-daily.yml` | Appointment Status schedules (7:23 AM → Sheet1, 1 PM → Next day) |
| `sql/01_schema.sql`, `sql/02_users.sql` | Create the database (run once in Supabase) |
| `bot_glossary.yaml` | Dictionary for the Teams bot (stage 2) |
| `.env.example`, `run_vetbuddy_export.bat` | Only for running VetBuddy on a Windows PC instead of GitHub |

---

## 1. VetBuddy sales (6:47 AM)

### The master sheet

| Column | Content |
|---|---|
| A – AW | The 49 VetBuddy columns, exactly as exported |
| AX | `=INT(B)` – the date without time. Correct in every language/region setting (the old `DATEVALUE(TEXT(…))` swapped day and month for the 1st–12th). All date filters should use AX. |
| AY | **VOW Unit** – `CH VET ON WHEELS`, `CBE VET ON WHEELS`, `MADURAI VET ON WHEELS`, `TRICHY VET ON WHEELS` on **every line of a Vet on Wheels invoice**; empty = clinic sales |

Each morning only the current month's rows are replaced (deleted + pasted fresh under the last row,
empty rows at the bottom removed). Values of older months are never changed; AX and AY are
re-applied to all rows, so if the VOW rules change, the whole history follows.
SharePoint keeps version history – any day's update can be undone (⋯ → Version history).
**Nobody should have the master open (desktop Excel or Excel for the web) at 6:47 AM** – the script
retries for 30 minutes, then reports a failure.

### Vet on Wheels rule (`vow.py`)
1. A line is a VOW item if *Services and Goods* contains `VOW`, or starts with `Home visit`,
   `Nobivac`, `Mobile Veterinary Consult`, or is exactly `Consultation VOW` (not case-sensitive).
2. If **any** line of an invoice is a VOW item, **every** line of that invoice is VOW.
3. The unit comes from the Billed Clinic: Chennai clinics → CH, Coimbatore → CBE, Madurai, Trichy.
   A VOW invoice from a clinic that is not in the list is marked `VOW - UNMAPPED CLINIC`.

To change the rules: edit the lists at the top of `vow.py` in GitHub (✏️ → commit) – the next
run applies them to the master and the database. `vow.py` follows the Settings sheet of the Daily
Sales Report (VOW rules H:I, clinic map D:F) – when the team changes that sheet, change `vow.py` the same day.

---

## 2. Gofrugal pharmacy (part of the 6:47 AM run)

Runs right after the VetBuddy steps, in the same workflow, when `GOFRUGAL_USER` / `GOFRUGAL_PASS` are set.

- Logs in to Gofrugal Prime HQ (`https://sanchuhq.gofrugal.com`) and downloads, for the 1st of
  the month → yesterday, all shops:
  - **3111 Sales Detail - Itemwise** (amount = "Item Amt BeforeTax")
  - **3126 Sales Return Detail - Itemwise** (amount = "Sub Total", deducted)
- Saves `Gofrugal_Pharmacy_MTD_<from>_to_<to>.xlsx` (sales and returns) in **Gofrugal Upload**
  (same library as CRM Upload). The 11:47 PM run moves it to **Gofrugal Archive**.
- Replaces the period's rows in the database table `vetbuddy.pharmacy_sales` (all or nothing).
  The whole month is reloaded every morning, because pharmacy bills can reach Gofrugal a day late.

**Pharmacy Vet on Wheels rule:** a pharmacy bill is VOW when the **same doctor** billed a VOW
invoice in VetBuddy on the **same date** at the **same clinic**. Doctors are matched by their
code (`P0xxxx` in the name) first, otherwise by name, with small spelling differences allowed
(`NAME_MATCH_MIN = 0.80` in `vow.py`). If a doctor is matched wrongly or missed, add them to
`DOCTOR_NAME_OVERRIDES` in `vow.py` (Gofrugal name in lower case → VetBuddy code, or `"NONE"`).

There is no pharmacy master workbook – the pharmacy data lives in the daily file and the database.

---

## 3. Corefactor call logs (6:53 AM)

- Exports **yesterday's All Calls** (IST) from Corefactor (Teleduce) – the same request as the
  *Export* button – waits for it in Export History, downloads and unzips it.
- The last 3 export columns are removed (as done by hand), then the rows are pasted under the last
  row of **Backend Call Log Report.xlsx** (sanchureports OneDrive → Sanchu Reports), matching columns
  by header name. New rows copy the format of the row above and the **"Date"** formula is dragged down.
- A copy of the day's file is saved in **Call Log Archive** (next to CRM Upload) every day – even
  when the master already had that day.
- **A day already in the master is skipped** (found by the "Date" column, or "Call Date" if Date has
  no value). Run by hand with *if_present = replace* to rewrite it (only possible while that day's
  rows are the last rows of the sheet).

### Signing in (important)
Corefactor's sign-in page has a CAPTCHA, so the robot **never logs in itself**. It reuses the
`sessionid` cookie of a browser where someone is signed in. When that session expires the run fails
with *"Corefactor session has expired"*. To fix it:
1. Sign in to Corefactor in Chrome/Edge (`https://tw1.teleduce.corefactors.in`).
2. Press **F12** → **Application** (Edge/Chrome) → **Cookies** → the Corefactor site → copy the
   **Value** of `sessionid`.
3. GitHub → Settings → Secrets and variables → Actions → `COREFACTOR_SESSIONID` → **Update** → paste.
4. Re-run the failed workflow(s): **Actions → Corefactor daily call logs / Corefactor daily Lead Box → Run workflow**
   (put the missed day in *date*).

Tip: don't click *Sign out* in that browser – signing out ends the session the robot uses.

---

## 4. Corefactor Lead Box (7:03 AM)

Same steps and the same `COREFACTOR_SESSIONID` as the call logs, but for **leads created yesterday** (All Leads):
- Export columns **AQ:BG** are removed, then the rows are appended to
  **Backend Leadbox Report.xlsx** (sanchureports OneDrive → Sanchu Reports).
- The formulas **"Date"** and **"Appt Datevalue"** are dragged down.
- The day's file goes to **Lead Box Archive**.
- A day already in the master (by "Date", else "Created Date") is skipped unless *if_present = replace*.

---

## 5. Runo call logs (7:13 AM)

- Fetches every call from the 1st of the month to yesterday through Runo's API
  (`api.runo.in`, one day at a time). On the 1st it takes the whole previous month.
- Saves `Runo_CallLogs_MTD_<from>_to_<to>.xlsx` in **Runo Upload** (next to CRM Upload).
- Updates **Runo CallLog.xlsx** (sanchureports OneDrive → Sanchu Reports):
  - if the master already has calls for **yesterday**, it is left unchanged (*if_present = replace* to rewrite);
  - otherwise all rows of this month are deleted, wherever they are, and the fresh month-to-date
    rows are pasted under the last row. The **"Date"** and **"Month"** formulas are dragged down.
    Other months are never touched.

Safety checks – the master is left unchanged if:
- any master header doesn't match the new data;
- Runo returns **fewer than 90 %** of the calls the master already holds for the period
  (something is wrong on Runo's side). Check Runo; to write anyway, run the script locally with `--force`.

---

## 6. VetBuddy Appointment Status (7:23 AM → Sheet1, 1 PM → Next day)

The same report the team makes by hand: **Settings → Business Intelligence → (scroll down)
Appointment Status → date range = yesterday → all units → Generate Report → Create XLS**
(status *All*, appointment type *All*). It uses the same VetBuddy login as the sales job.

- The day's file, without the 6 title rows, is saved as `VetBuddy_AppointmentStatus_<day>.xlsx`
  in **Appointment Status Archive** (next to CRM Upload).
- The rows are pasted under the last row of **Appointment Status.xlsx**
  (sanchureports OneDrive → Sanchu Reports), sheet **Sheet1**, as done by hand:

| Column | Content |
|---|---|
| A – S | The 19 VetBuddy columns, exactly as exported (Appointment ID … Future Custom Reminders) |
| T | **Created Date** `=DATEVALUE(TEXT(B,"dd-mm-yyyy"))` – dragged down |
| U | **Date** (appointment date) `=DATEVALUE(MID(C,5,2)&"-"&LEFT(C,3)&"-"&MID(C,8,4))` – dragged down |
| V | *Phone number* – not filled for new rows (it stopped being dragged down at row ~112,380) |

- VetBuddy's export for a day also lists a few appointments dated other days (rescheduled /
  multi-day bookings). They are pasted too, exactly like before, so the same Appointment ID can
  appear on two days.
- **A day already in the master is skipped** (most of that day's appointment IDs are already
  there with that Date in column U). Run by hand with *if_present = replace* to rewrite it – only
  possible for the most recent day added (its rows are the last rows of Sheet1).
- The morning run touches only Sheet1; **OLD DUMP** and **Full Month** are never touched.
- The workbook is ~80 MB, so Sheet1 is edited directly in the file (like the VetBuddy sales
  master), not opened in Excel; nothing else in the file changes.
- Missed days can be caught up in one run: **Run workflow → from / to** (oldest first).

### 1 PM run → sheet "Next day"
Every day at **1:01 PM IST** the same report is made for **today**, so it holds today's
appointments as they stand at 1 PM (the afternoon/evening bookings made so far, with their
status at that moment). The rows are pasted under the last row of the sheet **Next day**:

| Column | Content |
|---|---|
| A – S | The 19 VetBuddy columns |
| T | **Appt date** `=DATEVALUE(MID(C,5,2)&"-"&LEFT(C,3)&"-"&MID(C,8,4))` – dragged down |

- Only "Next day" is changed by this run (Sheet1 is not touched).
- If today is already in "Next day" (e.g. the workflow was run twice), it is skipped; choose
  *if_present = replace* to take a fresh 1 PM snapshot instead.
- A missed 1 PM run can't be redone later for that day with the 1 PM figures – VetBuddy only
  shows the statuses as they are now. Run it by hand as soon as possible
  (**Run workflow → run = "today (now) → Next day"**).
- The day's file is archived as `VetBuddy_AppointmentStatus_<day>_at_<HHMM>.xlsx`.

## Shared rules for all master workbooks

- The robot saves a master only if **nobody changed it meanwhile**; if it's open (locked) it
  retries (about 30 minutes for VetBuddy, Runo and Appointment Status, 5 attempts for Corefactor),
  then fails. **Keep the masters closed between 6:45 and 7:45 AM**, and *Appointment Status.xlsx*
  also around **1:00–1:15 PM**.
- SharePoint/OneDrive version history keeps every day's version (⋯ → Version history).
- The Corefactor and Runo masters are saved with openpyxl: data, formulas, styles and tables are
  kept, but **charts, images and slicers are dropped**. Keep those in a separate workbook that reads from the master.
- Don't rename or reorder header cells in a master – the robot matches columns by header name and stops if they differ.

---

## One-time setup

### A. GitHub repository
Repository `vetbuddy-export` (private) must contain **all** files above, with the workflows in
`.github/workflows/`.

**Settings → Secrets and variables → Actions**

Secrets:
| Name | Used by | Value |
|---|---|---|
| `VETBUDDY_USER` / `VETBUDDY_PASS` | VetBuddy, Appointment Status | VetBuddy login (just the value, no `NAME=`) |
| `GOFRUGAL_USER` / `GOFRUGAL_PASS` | Gofrugal | Gofrugal HQ login |
| `COREFACTOR_SESSIONID` | Call logs, Lead Box | `sessionid` cookie (see *Signing in* above) |
| `RUNO_API_KEY` | Runo | Runo → API Configuration → API key |
| `SP_TENANT_ID` / `SP_CLIENT_ID` / `SP_CLIENT_SECRET` | all | Azure app "VetBuddy Export" (Sites.ReadWrite.All, admin consent ✓) |
| `SUPABASE_DB_URL` | VetBuddy, Gofrugal | see C below |

Variables (only the first block is required; the others have the defaults shown):
| Name | Value |
|---|---|
| `SP_SITE_URL` | `https://sanchuhospital.sharepoint.com/sites/SalesTeam` |
| `SP_LIBRARY` | `Sales Reports Sanchu` |
| `SP_FOLDER` | `CRM Upload` |
| `SP_ARCHIVE_FOLDER` | `CRM Archive` |
| `SP_MASTER_PATH` | `Vetbuddy Master Data 2.xlsx` |

| Optional variable | Default |
|---|---|
| `SP_MASTER_SITE_URL` / `SP_MASTER_LIBRARY` | same as `SP_SITE_URL` / `SP_LIBRARY` |
| `SP_GOFRUGAL_FOLDER` / `SP_GOFRUGAL_ARCHIVE_FOLDER` | `Gofrugal Upload` / `Gofrugal Archive` |
| `GOFRUGAL_URL` | `https://sanchuhq.gofrugal.com` |
| `COREFACTOR_BASE_URL` | `https://tw1.teleduce.corefactors.in` |
| `SP_CALLLOG_SITE_URL`, `SP_LEADBOX_SITE_URL`, `SP_RUNO_SITE_URL` | `https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in` |
| `SP_CALLLOG_LIBRARY`, `SP_LEADBOX_LIBRARY`, `SP_RUNO_LIBRARY` | `Documents` |
| `SP_CALLLOG_MASTER_PATH` | `Sanchu Reports/Backend Call Log Report.xlsx` |
| `SP_LEADBOX_MASTER_PATH` | `Sanchu Reports/Backend Leadbox Report.xlsx` |
| `SP_RUNO_MASTER_PATH` | `Sanchu Reports/Runo CallLog.xlsx` |
| `SP_CALLLOG_ARCHIVE_FOLDER` / `SP_LEADBOX_ARCHIVE_FOLDER` / `SP_RUNO_UPLOAD_FOLDER` | `Call Log Archive` / `Lead Box Archive` / `Runo Upload` |
| `RUNO_PROCESS` | empty = all Runo processes |
| `SP_APPT_SITE_URL` / `SP_APPT_LIBRARY` | `https://sanchuhospital-my.sharepoint.com/personal/sanchureports_sanchu_co_in` / `Documents` |
| `SP_APPT_MASTER_PATH` / `SP_APPT_SHEET` / `SP_APPT_TODAY_SHEET` | `Sanchu Reports/Appointment Status.xlsx` / `Sheet1` / `Next day` |
| `SP_APPT_ARCHIVE_FOLDER` | `Appointment Status Archive` |

Folders that don't exist yet are created automatically.

### B. Microsoft (already done)
Azure → Entra ID → App registrations → *VetBuddy Export* → API permissions:
Microsoft Graph **Sites.ReadWrite.All (Application)**, status **✓ Granted**.
The same app writes to the SalesTeam site and to the sanchureports OneDrive.
The client secret expires (24 months) – renew it and update `SP_CLIENT_SECRET` **before** then,
or every job stops uploading.

### C. Supabase (database for the Teams bot)
1. supabase.com → New project (live project: `ykmgbuooksizjqsyfhut`, region Northeast Asia (Seoul)); save the database password.
2. **SQL Editor → New query**: paste `sql/01_schema.sql` → Run.
3. Edit `sql/02_users.sql`: replace the two passwords (letters + digits only) → paste → Run.
4. **Connect → Session pooler** → copy the URI, change `postgres.` to `vb_loader.` and put password 1 in →
   GitHub secret `SUPABASE_DB_URL`.
5. **Actions → VetBuddy daily MTD export → Run workflow → `backfill`** once (~2 min): loads the whole master history.
6. Then **`backfill_pharmacy`** once: loads Gofrugal history month by month, from the first month
   in the database up to yesterday.

The data is in schema `vetbuddy` (not published by Supabase's web API). Login `vb_loader` can only
replace rows; login `vb_bot` can only read views **without** phone, email, GST, client ID or names.
The bot's views: `v_all_sales` (VetBuddy + pharmacy, matches the Daily Sales Report), `v_sales_bot`,
`v_pharmacy_bot`, `v_data_freshness` – see `bot_glossary.yaml`.

### D. Supabase usage and inventory (checked 17–18 Nov 2026)

**Project:** `ykmgbuooksizjqsyfhut` ("sanchumarketing-tech's Project") · organization on the **Free plan** ·
region **Northeast Asia (Seoul), ap-northeast-2** · compute **Nano** · disk 2 GB.

#### Counts

| Item | Count | Details |
|---|---|---|
| **Pooling users** (logins through the connection pooler, Supavisor) | **2** | `vb_loader` – all GitHub Actions jobs (session mode, port 5432)<br>`vb_teams` – the Teams bot Edge Function (transaction mode, port 6543) |
| **Edge Functions** | **2** | `teams-bot` – the "Sanchu Sales" Microsoft Teams bot (`bot/teams-bot/index.ts`), JWT check off (it checks Microsoft's token itself)<br>`corefactor` – Corefactor's live push of call logs (`supabase/functions/corefactor/index.ts`, link `functions/v1/corefactor/calls`), JWT check off (it checks the key in the link); added 18 Nov 2026 |
| **Triggers (ours)** | **1** | `refresh_pbi_after_load` on `vetbuddy.load_log` → `vetbuddy.trg_refresh_pbi()`: refreshes the Power BI summary tables after each VetBuddy load |
| Event triggers (installed by Supabase) | 7 | `pgrst_ddl_watch`, `pgrst_drop_watch` (API schema reload), `issue_graphql_placeholder`, `issue_pg_graphql_access`, `issue_pg_cron_access`, `issue_pg_net_access`, `ensure_rls` – part of every Supabase project, not ours |
| Scheduled jobs inside Supabase (pg_cron) | 0 | every schedule is a GitHub Actions job (below) |

Other logins (not through the pooler): `authenticator` – Supabase's web API, used by the Call Desk website (Vercel)
and the Google Sheet's Apps Script (`sheet_push`); `postgres` – admin / SQL editor; `vb_bot` – older read-only
bot login, not in use. Pooler settings: pool size 15 per login, max 200 client connections (fixed for Nano).
Database connections at a quiet moment: 7 of 60.

#### What is in the database (≈ 400 MB)

| Schema | Contents | Size |
|---|---|---|
| `vetbuddy` | 27 tables, 13 views, 3 materialized views (Power BI summaries). Largest: `sales` 223 MB (bill lines from 20 Dec 2025), `pharmacy_sales` 35 MB, `sales_old_summary` 8 MB (one row per phone for 2019 – 19 Dec 2025), `mv_pbi_*` 15 MB | ≈ 283 MB |
| `calldesk` | 13 tables: `queue` (daily lists) 39 MB, `calls` (Corefactor + Runo logs) 31 MB, `leads` (Lead Box) 19 MB, `appointments` 9 MB (from 1 Oct 2026), `followups`, `agents`, `sessions`, `reminders`, `settings`, … | ≈ 101 MB |
| `auth` | 2 users (from an early email-login test; the Call Desk uses its own name + PIN login) | 1.5 MB |
| `public`, `storage` | no tables, no storage buckets | 0 |

Database functions: **39** – `public` 22 (20 `cd_*` functions called by the Call Desk website, `sheet_push`,
`rls_auto_enable`), `calldesk` 10 (list build, balancing, rules), `vetbuddy` 7 (Power BI helpers, refresh).
Extensions: plpgsql, pg_stat_statements, uuid-ossp, pgcrypto (PIN hashing), supabase_vault, pg_trgm.
Not used: Storage, Realtime, row-level-security policies (the website only reaches data through the `cd_*`
functions, which check the signed-in agent themselves), Supabase Auth sign-ins.

#### Who uses the database

| Caller | How | When (IST) |
|---|---|---|
| GitHub Actions (`vb_loader`, pooler) | VetBuddy sales 6:47 · Corefactor 6:53 · Lead Box 7:03 · Camp master 7:11 · Runo 7:13 · Appointments 7:23 + 1:01 PM · Reminders 7:47 · Call Desk build 8:05 · Call Desk Excel log hourly 9:11 AM – 10:11 PM · by hand: Call Desk dry run, history load | mornings + hourly |
| Call Desk website (Vercel) | Supabase web API → `cd_*` functions | office hours |
| Teams bot (`teams-bot` Edge Function, `vb_teams`) | pooler | when asked |
| Google Sheet dashboard (Apps Script) | web API → `sheet_push` | after the 9 AM import |

Database queries since the statistics were last reset: `vb_loader` 71,535 · `postgres` 6,043 ·
`vb_teams` 3,024 · website (`anon` + `authenticator`) ≈ 5,500 · Supabase internal 11,200.

#### Billable items ("consumables") – billing cycle 4 Nov – 4 Dec 2026

| Item | What it is for us | Used | Free plan | Pro plan (per project) | Price above Pro |
|---|---|---|---|---|---|
| **Compute** (the Postgres server) | runs everything | Nano, always on | Nano | Micro (1 GB RAM) – **$10/month**; the plan's $10 credit covers one server per organization | Small $15, Medium $60 … |
| **Database size / disk** | our data | **0.41 GB** (86 % of Free) | 0.5 GB (read-only when full) | 8 GB | $0.125 per GB / month |
| **Egress** | data sent out (website, bot, job reads) | 0.13 GB | 5 GB | 250 GB | $0.09 per GB |
| **Edge Function runs** | Teams bot; Corefactor push (from 18 Nov 2026, about 1,000–2,000 a day expected) | 135 | 500,000 | 2,000,000 | $2 per million |
| **Monthly active users** | Supabase Auth | 1 | 50,000 | 100,000 | $0.00325 each |
| File storage | not used | 0 | 1 GB | 100 GB | $0.021 per GB |
| Realtime | not used | 0 | 200 connections | 500 | — |
| API requests, pooler connections, database functions, triggers, logs | — | — | **not billed** | **not billed** | — |

**Cost if this project moves into the company's paid (Pro) organization:** about **+$10 a month** – only the
project's own Micro server. Every usage item above is far below what Pro includes, so no overage is expected.
(Pro is $25 per organization and includes $10 of compute credit, which the existing paid project already uses;
each additional project pays its own server. Prices from supabase.com/pricing, Nov 2026.)

Growth to watch: the Call Desk tables grow ≈ 10–20 MB a day without cleanup; VetBuddy sales ≈ 17–19 MB a month.
On the Free plan the 0.5 GB limit puts the project in **read-only mode** (it happened once, 16 Nov 2026).

---

## Running by hand

**Actions → (workflow) → Run workflow**:

| Workflow | Options |
|---|---|
| VetBuddy daily MTD export | `export` – morning run (VetBuddy → CRM Upload → master → database → Gofrugal) · `archive` – move Upload → Archive folders · `backfill` – reload the whole master into the database · `backfill_pharmacy` – reload Gofrugal history |
| Corefactor daily call logs | *date* (YYYY-MM-DD, empty = yesterday) · *if_present* `skip` / `replace` |
| Corefactor daily Lead Box | *date* (created date, empty = yesterday) · *if_present* `skip` / `replace` |
| Runo daily MTD call logs | *from* / *to* (empty = 1st of month → yesterday) · *if_present* · *file_only* (just make and upload the file) |
| VetBuddy daily Appointment Status | *run*: `yesterday → Sheet1` (morning) or `today (now) → Next day` (1 PM) · for Sheet1: *date* (one day, empty = yesterday) **or** *from* / *to* (catch up, max 2 months) · *if_present* · *file_only* |

To catch up missed Corefactor days, run the workflow once per day, oldest first.
Runo only gives past days – *to* must be yesterday or earlier.

## What a good morning log looks like
VetBuddy + Gofrugal:
```
Logged in as ***
Requesting report 2026-11-01 -> 2026-11-03 (all clinics)...
Saved …MTD_2026-11-01_to_2026-11-03.xlsx (0.7 MB, 3964 data rows)
Uploaded to SharePoint: CRM Upload/…
Master: removed 2950 rows of 11/2026, removed 0 empty rows, added 3964 rows (now 300014 rows incl. header); VOW: 4350 invoices / 19400 lines flagged in column AY
Master updated in SharePoint: Vetbuddy Master Data 2.xlsx
Database: removed 2950 rows of 11/2026, added 3964 rows (85 VOW invoices)
Gofrugal: logged in as …
Saved Gofrugal_Pharmacy_MTD_2026-11-01_to_2026-11-03.xlsx (… sales lines, … return lines)
Pharmacy: removed … rows, added … rows for 2026-11-01..2026-11-03 (total …, of which VOW …)
```
Corefactor (call logs / Lead Box):
```
Signed in to Corefactor (session is valid)
Requested Call Logs export for 2026-11-03 as '…'
Export is ready in Export History
Header check passed: all … columns match the master; pasting
Appended … rows to '…'
Master workbook saved to SharePoint
Archived Corefactor_CallLogs_… in 'Call Log Archive'
Done: … rows for 2026-11-03 added to the master sheet
```
Runo:
```
Runo call logs 2026-11-01 to 2026-11-03
2026-11-01: … calls   (one line per day)
Fetched … calls in total
Uploaded to SharePoint: Runo Upload/Runo_CallLogs_MTD_…
Master: replaced … rows of 2026-11-01 to 2026-11-03 with … rows
Done: master updated with … calls (2026-11-01 to 2026-11-03)
```

## Troubleshooting

**All jobs**
| Log says | Do this |
|---|---|
| `401 Unauthorized` (graph.microsoft.com) / `Could not sign in to Microsoft Graph` | Azure admin consent not granted / client secret expired → renew, update `SP_CLIENT_SECRET` |
| `Library '…' not found. Available: …` | Fix the library variable (copy a name from the list) |
| `Master is open/locked` / `Could not save the master …` | Someone had the master open – close it and run the workflow by hand |
| `Header check failed` / `Master columns don't match the export` | The source changed its columns, or someone edited a header – master was NOT changed; send the log |
| GitHub email "Run failed" | Open the run → red step → read the last lines |

**VetBuddy / Gofrugal**
| Log says | Do this |
|---|---|
| `VETBUDDY_USER / VETBUDDY_PASS missing` | Secrets missing or misspelled |
| `Login failed` | VetBuddy password changed → update the secret. `login_debug.html` is in the run's Artifacts |
| `Column AY already holds …` | Someone typed in column AY – clear it |
| `Database load FAILED` / `Pharmacy load FAILED` | Check `SUPABASE_DB_URL` (Session pooler, `vb_loader.` user). Yesterday's data stays in the database |
| `Gofrugal download FAILED` | Check `GOFRUGAL_USER` / `GOFRUGAL_PASS`; try the login in a browser |
| `Gofrugal step skipped` | `GOFRUGAL_USER` / `GOFRUGAL_PASS` are not set |

**Corefactor**
| Log says | Do this |
|---|---|
| `Corefactor session has expired` | New `sessionid` cookie → `COREFACTOR_SESSIONID` (see *Signing in*), then re-run with the missed date |
| `… FAILED. Re-run the workflow.` / `not ready in Export History within … minutes` | Corefactor was slow or failed – just run it again |
| `The master sheet already has …, so it was left unchanged` | Normal when the day was already added. Use *if_present = replace* to rewrite |
| `… is already in the master sheet but its rows are not the last rows` | Replace is only possible for the latest day – fix that day by hand |
| `No formula found in the '…' column … to drag down` | The last row of the master lost its Date/Appt Datevalue formula – put it back |
| `The export has no rows for …` | No calls/leads that day (e.g. holiday) – nothing to do |

**Runo**
| Log says | Do this |
|---|---|
| `Runo refused the API key` | New key in Runo → API Configuration → update `RUNO_API_KEY` |
| `Runo returned … calls …, but the master already holds …` | Runo returned too few calls – check Runo; master was NOT changed |
| `The master already has calls for …` | Normal when already done. Use *if_present = replace* to rewrite |
| `No calls returned …` | Nothing uploaded, master not changed – check `RUNO_PROCESS` / the Runo account |

**Appointment Status**
| Log says | Do this |
|---|---|
| `Login failed` / `VETBUDDY_USER / VETBUDDY_PASS missing` | Same as the VetBuddy sales job |
| `Report page did not return an XLS link` | VetBuddy session/page changed – re-run; if it repeats, send the log |
| `Report columns changed` / `'…' headers don't match` | VetBuddy or someone changed the columns (row 1: A–U in Sheet1, A–T in Next day) – master NOT changed; send the log |
| `The master already has …, so it was left unchanged` | Normal when the day was already added |
| `… is not the last day added` | Replace only works for the latest day – fix older days by hand |
| `Master is open/locked` / `Could not save the master …` | Close *Appointment Status.xlsx* and run the workflow again (for the 1 PM run: choose `today (now) → Next day`) |
| `the report has no appointments` | Nothing booked that day – nothing to do |

Every run keeps its files and log for 14 days (run page → Artifacts): VetBuddy and Appointment Status
`vetbuddy_export.log` + `login_debug.html`; Corefactor and Runo `corefactor_export.log` (+ `corefactor_debug.html`).
