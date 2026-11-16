# Sanchu VetBuddy data & Teams analyst bot — project overview
Saved 11 Nov 2026. Nothing in this repo contains passwords or keys; those live in GitHub secrets,
Supabase secrets and Apps Script properties (see "Where the secrets are").

## What runs where
| Part | Where it runs | Folder here |
|---|---|---|
| Daily VetBuddy + Gofrugal export (6:47 AM), night archive (11:47 PM), master sheet update, Supabase load, `reload_month` | GitHub Actions, repo `sanchumarketing-tech/vetbuddy-export` | repo root (`*.py`, `.github/workflows/`) |
| Other daily jobs: appointments, Corefactor call logs, Leadbox, Runo | same repo | repo root |
| Database (sales, pharmacy, sheet numbers, Power BI columns, bot memory) | Supabase project `ykmgbuooksizjqsyfhut`, schema `vetbuddy` | `sql/` (run in order 01 → 12) |
| Teams analyst bot "Sanchu Sales" | Supabase Edge Function `teams-bot` (Verify JWT off) | `bot/teams-bot/index.ts` |
| Teams app package (uploaded & approved in the Sanchu tenant) | Teams | `bot/teams-app/` |
| Daily report picture to Teams + WhatsApp, numbers to Supabase | Google Sheet (Apps Script) | `gsheet/` (copies; the live code is in the sheet) |

## Data files (SharePoint)
- Master: `sanchureports` OneDrive → Sanchu Reports → **Vetbuddy Master Data 2.xlsx** (Dec 2025 →, updated by the job)
- Older history: Sanchu Reports → Vetbuddy Master Data.xlsx (30 Jul 2019 → 19 Dec 2025) stays in SharePoint; Supabase keeps only vetbuddy.sales_old_summary - one row per phone (54,174 rows, ~8 MB) - see sql/20_sales_history.sql
- Call log: Backend Call Log Report.xlsx (table `vetbuddy.call_log`, not yet loaded)

## Database files
| File | What it creates |
|---|---|
| 01–03 | sales, loaders, users, pharmacy |
| 04 | sheet numbers (sheet_daily / sheet_targets / sheet_kpi) + push RPC |
| 05–08 | bot tables, Teams login `vb_teams`, templates, conversation memory |
| 09 | the 79 Power BI "Vetbuddy" calculated columns → `v_vetbuddy_pbi` (+ lookup tables) |
| 10 | other Power BI tables (calendar, client table, summaries, month / category tables) |
| 11 | access rules — bots only see `v_vetbuddy_pbi_bot` (no personal data) |
| 12 | analyst bot: saved plans `bot_plan`, saved analyses `bot_answer` |
Re-running 09 drops the views of 10 and 11 → run 10 and 11 again after it.

## The Teams bot (teams_bot/index.ts)
Plan (2–4 queries: answer, context, drivers) → run read-only → analyse (+1 drill-down) → 2nd-model review →
every number checked in code against the results. Groq models: gpt-oss-120b, qwen3.8-27b, gpt-oss-20b with fallback.
Conversation memory 30 min; "new question" resets; "wrong" forgets an analysis; "usage" shows today's tokens.
To redeploy: Supabase → Edge Functions → teams-bot → Code → paste index.ts → Deploy updates.

## Where the secrets are
- GitHub repo secrets: VETBUDDY_USER/PASS, SP_TENANT_ID/CLIENT_ID/CLIENT_SECRET, SUPABASE_DB_URL, GOFRUGAL_USER/PASS
- Supabase Edge Function secrets: AI_API_KEY (Groq), BOT_DB_URL, BOT_APP_ID, BOT_APP_SECRET, BOT_TENANT_ID, ALLOWED_CONVERSATIONS
- Apps Script properties: Supabase push key, Green API (WhatsApp), Power Automate URL

## Open items
1. Load the old master (before 20 Dec 2025) so "new vs repeat pet" and visit counts use full history.
2. Daily call-log load from SharePoint into `vetbuddy.call_log`; Deceased Data file.
3. October 2026: database (reloaded from VetBuddy) is Rs 41,148 below the sheet — 9 invoices returned after 1 Nov
   (Rs 18,385) plus older differences (Rs 22,763); master sheet's October still has the 1 Nov numbers.

See bot/STATUS.md for the full change log.
