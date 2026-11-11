# Sanchu Sales Teams bot – status (10 Nov 2026, 17:20 IST)

## Waiting on
- Teams admin approval of the app **Sanchu Sales** (submitted from Teams > Apps > Manage your apps >
  "Submit an app to your org"). Admin: Teams admin center > Teams apps > Manage apps > Sanchu Sales >
  Publishing status = Published, Allowed.
- Then: Apps > Sanchu Sales > Add > Add to a chat > "Sanchu Core team"; test "@Sanchu Sales Madurai sales this month".

## Done
| Piece | Where / value |
|---|---|
| Sheet numbers -> Supabase | Apps Script botPush_ after the 9 AM import; menu "Send numbers to Supabase (bot) now". Tables vetbuddy.sheet_daily / sheet_targets / sheet_kpi (sql/04_sheet_numbers.sql) |
| Bot tables | sql/05_bot.sql: v_report_check, bot_memory (saved questions + SQL + insights), bot_usage (tokens/day) |
| Bot DB login | **vb_teams** (sql/06_teams_login.sql), read-only + write only to bot_memory/bot_usage. vb_bot left unchanged |
| Bot code | Supabase Edge Function **teams-bot** = bot/teams-bot/index.ts; Verify JWT = OFF (code checks Microsoft's token itself) |
| Endpoint | https://ykmgbuooksizjqsyfhut.supabase.co/functions/v1/teams-bot |
| Bot registration | Teams Developer Portal > Tools > Bot management > "Sanchu Sales", Bot ID d293ec8a-1c7f-4249-91b8-743841af9106 |
| Teams app package | bot/teams-app/SanchuSalesBot.zip (make_app.py <BOT_ID>) – scope groupChat |
| AI | Google Gemini free tier, model gemini-3.8-flash, key in Google Cloud project "My Project 56668" (apt-bonbon-514310-r2). Groq refused sign-up (signup_blocked); set AI_PROVIDER=groq later if unblocked |

## Supabase Edge Function secrets (project ykmgbuooksizjqsyfhut)
BOT_TENANT_ID = 2ce469ed-340c-4876-a18e-d66f4d240c99 · ALLOWED_CONVERSATIONS = 19:00c8324d0627468caf8c558c437db3e1@thread.v2 ·
BOT_APP_ID = d293ec8a-1c7f-4249-91b8-743841af9106 · BOT_APP_SECRET, BOT_DB_URL (vb_teams via pooler
aws-0-ap-northeast-2.pooler.supabase.com:6543), AI_API_KEY (entered by the user, not stored anywhere else).
Optional: AI_PROVIDER (gemini|groq), AI_MODEL, DAILY_TOKEN_CAP.

## How the bot saves tokens
1. Same/reworded question (same key-word signature) -> saved SQL re-run, 0 AI tokens.
2. New question -> one AI call returns only {sql,title}; bot formats the table itself; similar saved questions
   are given as examples. One repair call only if the SQL fails.
3. "insights/why/explain" -> one short AI call, saved and re-used until the data date changes.
4. Commands: help, usage (today's tokens), wrong (forget last answer), chat id.

## If something breaks
Supabase > Edge Functions > teams-bot > Logs. Typical: wrong BOT_DB_URL password, Gemini 429 (free limit),
bot login type (code tries botframework.com then the Sanchu tenant automatically).

## Update 11-11-2026 — follow-up questions (live)
- AI: Groq (openai/gpt-oss-120b, reasoning low). DB login for the bot: vb_teams (read-only; writes only bot tables).
- SQL run: 07_bot_templates.sql (templates + bot_insight), 08_bot_context.sql (bot_context, per-chat memory for 2 h).
- teams-bot (39,136 chars) deployed: place/period parsed by code, question type = memory key,
  templates reused at 0 tokens, built-in sales split-up, insights cached.
- Follow-ups: a message that leaves out the place, period or question reuses the last one in that chat
  ("and Trichy?", "same for last month", "split by doctor"). Card note shows "Follow-up (same ...)".

## Update 11-11-2026 — Power BI "Vetbuddy" columns (live)
- sql/09_vetbuddy_pbi.sql: 79 DAX calculated columns of Sharpshooting_Data.pbix -> view vetbuddy.v_vetbuddy_pbi
  (mv_pbi_owner / mv_pbi_pet / mv_pbi_pet_day refreshed by trigger after each load_log insert),
  lookup tables ref_unit, ref_plan_subcategory, ref_breed_obase; empty ref_deceased, call_log.
- sql/10_pbi_other_tables.sql: ref_month, ref_call_status_type, ref_category + views v_pbi_calendar,
  v_pbi_unique_client_id, v_pbi_client_table, v_pbi_summary_table, v_pbi_summary_phone_no.
- sql/11_pbi_access.sql: bots read only v_vetbuddy_pbi_bot (no personal data; pet_key/owner_key = md5 ids).
  Re-running 09 drops the views of 10/11 -> re-run 10 and 11 after it.
- teams-bot SYSTEM prompt knows v_vetbuddy_pbi_bot (40,968 chars deployed).
- TODO: old master (Vetbuddy Master Data.xlsx, before 20-12-2025) not loaded; Deceased Data empty;
  call log loader (SharePoint "Backend Call Log Report.xlsx" -> vetbuddy.call_log) to add to the GitHub job.

## Update 11-11-2026 (afternoon) — analyst bot (live)
- teams-bot rewritten as an analyst: PLAN (2-4 queries with placeholders incl. {{PREV_FROM}}/{{PREV_TO}}/{{LM_FROM}}/{{LM_TO}})
  -> RUN (read-only; failing query repaired by gpt-oss-20b) -> ANALYSE (may run 1 drill-down query)
  -> CHECK (every number in the answer must be in the query results; qwen3.8-27b rewrites unsupported claims; rest removed).
- Models per step (env overrides AI_PLAN_MODELS etc.): plan/analyze 120b > qwen3.8-27b > 20b; review qwen > 120b; fix 20b > qwen > 120b.
- sql/12_bot_analyst.sql: bot_plan (saved plans per question type), bot_answer (finished analysis per type+units+dates+data date),
  bot_context.headline; junk bot_memory rows 7,9,10,11,12,14,15 switched off. bot_memory (old templates) no longer used.
- Conversation: own question = new question (inherits place/period if not named); no own question = follow-up;
  small talk / "stop" / "what LLM" handled without data; context lasts 30 min.

## Update 11-11-2026 (evening) — prompt & format tuning (live, 56,867 chars)
- Results go to the AI pre-formatted (Indian commas, %) and the AI must copy numbers exactly - no own maths.
- A 2nd model (qwen3.8-27b) reviews EVERY answer for numbers, direction words (up/down) and "only/all/highest" claims,
  then the code check runs; an unsupported headline is replaced by the first verified point.
- Plan prompt: ANSWER / CONTEXT (same days last month, previous period, target) / DRIVERS; wide tables, max 15 rows, TOTAL row,
  plain-English titles. Answer: headline (<=25 words), 3-5 "Label: sentence" points, "What to do" line.
- Card: readable column titles, bar-chart column on the main table, follow-up questions as buttons (messageBack).
- bot_plan / bot_answer / bot_context cleared after the change.

## Update 11-11-2026 (16:30) — AI assistant front door (live, 70,249 chars)
- Every message first goes to an AI assistant (chat models 120b > qwen > 20b, temperature 0.4) that knows the person's name,
  the time of day, the last 3 hours of conversation (vetbuddy.bot_turns, sql/13) and a live sales snapshot (sheet_kpi + sheet_daily).
- It chats itself (greetings with a business pulse, thanks, ideas, drafting messages, snapshot answers - numbers checked,
  unsupported sentences removed) or hands ONE self-contained English question to the analyst pipeline.
- Persona: calm expert colleague; always English (understands Tanglish). Hard-coded help / thanks / "which LLM" replies removed.

## Update 11-11-2026 (16:45) — brief by default, fewer tokens (live, 74,410 chars)
- Brief answers unless insights / why / split / list / top / compare / trend is asked (assistant sets "detail"):
  1 query, a short answer prompt WITHOUT the table schema (much fewer tokens), no tables, no AI review (code number check only).
- Detail answers: 2nd-AI review only when the code check finds unsupported numbers (was: always).
- Questions from the assistant are self-contained -> the analyst no longer inherits the previous place / period.
- If the assistant AI fails, non-data messages ("thanks") get a short reply instead of going to the analyst.
- Card footer shortened (place · period · data date). bot_context / bot_turns / bot_answer cleared.

## Update 11-11-2026 (17:20) — understands the question, house rules, professional tone (live, 82,827 chars)
- The assistant now writes a structured understanding of every data question: units, from/to, and the comparison
  period asked (e.g. "yesterday vs last week" = 10 Nov vs 3 Nov). The analyst uses it as-is (no regex guessing).
  Plan prompt: "COMPARISON ASKED ... use {{PREV_FROM}}/{{PREV_TO}}; never answer for another period".
- House rules ("negative prompts"), sql/14_bot_rules.sql: table vetbuddy.bot_rules, 8 starting rules; added to every
  answer-writing AI step. Teams: "rules", "add rule: never ...", "remove rule 2".
- Professional tone (no emojis), unit names in Title Case, no block-chart column, "What to do" only for insights.
- bot_plan / bot_answer / bot_context / bot_turns cleared.
