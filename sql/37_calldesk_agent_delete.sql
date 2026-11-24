-- 24 Nov 2026: team leads can delete an agent (Agents tab -> Delete).
-- No call history -> the agent row is removed. With history (list rows, timed customers) -> switched off,
-- PIN cleared, hidden from the Agents tab (deleted_at), so past calls, KPIs and incentives keep the name.
-- Either way: signed out, today's untouched numbers go back to the pool, rebalance_today() runs.
-- Not allowed: deleting yourself, or the last active team lead.
-- Live patches: cd_team lists only agents with deleted_at is null; cd_agent_save re-adding the same email
-- brings a deleted agent back (deleted_at = null).
alter table calldesk.agents add column if not exists deleted_at timestamptz;
-- public.cd_agent_delete(p_id integer) returns jsonb - see sql/live/public.cd_agent_delete.sql
