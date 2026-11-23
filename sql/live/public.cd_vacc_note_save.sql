-- live definition of public.cd_vacc_note_save(p_phone text, p_pet_id text, p_note text, p_pet_name text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_vacc_note_save(p_phone text, p_pet_id text, p_note text, p_pet_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); n text := left(nullif(trim(p_note), ''), 500);
begin
  if m.id is null or (m.role <> 'lead' and not exists (
       select 1 from calldesk.queue q where q.phone = p_phone and q.agent_id = m.id and q.list_date >= calldesk.today() - 30))
  then raise exception 'not allowed' using errcode = '42501'; end if;
  if n is null then
    delete from calldesk.pet_vacc_notes where phone = p_phone and pet_id = p_pet_id;
    return null;
  end if;
  insert into calldesk.pet_vacc_notes (phone, pet_id, pet_name, note, by_name, updated_at)
  values (p_phone, p_pet_id, nullif(trim(p_pet_name), ''), n, m.name, now())
  on conflict (phone, pet_id) do update set note = excluded.note, pet_name = coalesce(excluded.pet_name, pet_vacc_notes.pet_name),
                                            by_name = excluded.by_name, updated_at = now();
  return jsonb_build_object('note', n, 'by', m.name, 'at', now());
end $function$
;
