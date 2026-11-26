-- live definition of calldesk.is_off(p_agent integer, p_day date) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.is_off(p_agent integer, p_day date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$ select exists (select 1 from calldesk.agent_off where agent_id = p_agent and day = p_day) $function$
;
