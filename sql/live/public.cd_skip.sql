-- live definition of public.cd_skip(p_id bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_skip(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); t timestamptz;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.queue set skipped_at = now() where id = p_id and (agent_id = m.id or m.role = 'lead') returning skipped_at into t;
  if t is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('skipped_at', t);
end $function$
;
