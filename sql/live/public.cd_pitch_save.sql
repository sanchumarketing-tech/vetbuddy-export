-- live definition of public.cd_pitch_save(p_id bigint, p_items text[]) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_pitch_save(p_id bigint, p_items text[])
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); q calldesk.queue; v text[];
begin
  select * into q from calldesk.queue where id = p_id and (agent_id = m.id or m.role = 'lead');
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select array_agg(x order by array_position(array['Grooming','Vaccination','Consultation','Clinical'], x)) into v
    from unnest(coalesce(p_items, '{}')) x where x in ('Grooming','Vaccination','Consultation','Clinical');
  update calldesk.queue set pitch = v, updated_at = now() where id = p_id;
  return coalesce(v, '{}');
end $function$
;
