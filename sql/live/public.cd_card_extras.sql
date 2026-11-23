-- live definition of public.cd_card_extras(p_id bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_card_extras(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); q calldesk.queue;
begin
  select * into q from calldesk.queue where id = p_id and (agent_id = m.id or m.role = 'lead');
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('pitch', coalesce(to_jsonb(q.pitch), '[]'),
    'vacc', coalesce((select jsonb_object_agg(pet_id, jsonb_build_object('note', note, 'by', by_name, 'at', updated_at))
                        from calldesk.pet_vacc_notes where phone = q.phone), '{}'));
end $function$
;
