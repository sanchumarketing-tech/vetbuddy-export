-- live definition of public.cd_save(p_id bigint, p_outcome text, p_note text, p_callback timestamp with time zone) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_save(p_id bigint, p_outcome text, p_note text DEFAULT NULL::text, p_callback timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); q calldesk.queue;
begin
  select * into q from calldesk.queue where id = p_id and (agent_id = m.id or m.role = 'lead');
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_outcome = 'callback' and p_callback is null then raise exception 'pick a call-back time'; end if;
  update calldesk.queue set outcome = nullif(p_outcome, ''), note = nullif(trim(p_note), ''),
         callback_at = case when p_outcome = 'callback' then p_callback end, updated_at = now()
   where id = p_id;
  if p_outcome in ('wrong_number', 'dnd', 'deceased') then
    insert into calldesk.exclusions (phone, reason, note, added_by)
    values (q.phone, p_outcome, nullif(trim(p_note), ''), m.email)
    on conflict (phone) do update set reason = excluded.reason, note = excluded.note,
                                      added_by = excluded.added_by, added_at = now();
  end if;
end $function$
;
