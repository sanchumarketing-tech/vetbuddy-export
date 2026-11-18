-- live definition of calldesk.me() - exported from the database
CREATE OR REPLACE FUNCTION calldesk.me()
 RETURNS calldesk.agents
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select a from calldesk.sessions s join calldesk.agents a on a.id = s.agent_id
  where s.token = nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-cd-token', '')
    and s.expires_at > now() and a.active
  limit 1
$function$
;
