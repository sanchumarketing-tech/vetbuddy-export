# Teams chatbot "Sanchu Sales" — deleted 25 Nov 2026

Removed on request; the code in this folder and the bot SQL files (sql/05–08, 11–15) are kept only as history.

- Supabase: Edge Function `teams-bot` and its secrets; bot tables/views (bot_memory, bot_usage, bot_context, bot_plan,
  bot_answer, bot_turns, bot rules/log, templates/insight, v_vetbuddy_pbi_bot); sheet numbers (sheet_daily,
  sheet_targets, sheet_kpi, sheet_sync_log, public.sheet_push); bot logins vb_teams / vb_bot; camp_master.
- Sales Report Apps Script: botPush_ (sheet numbers -> Supabase) and the Teams report post removed; properties
  SB_URL / SB_ANON / SB_PUSH_KEY / TEAMS_WEBHOOK_URL deleted. The picture still goes to WhatsApp.
- GitHub: camp-master-sync.yml schedule off.
- Kept (used by the Call Desk): the VetBuddy data in Supabase and the Power BI views (sql/09, sql/10).
- Microsoft side (done by the owner): bot "Sanchu Sales" in the Teams Developer Portal, its Azure app registration,
  the Teams app in the Teams admin center; AI keys (Groq / Google Gemini) revoked.
