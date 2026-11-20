-- Call Desk (20 Nov 2026): "What to pitch next" tick boxes + vaccination details typed on a pet card.
-- Both are written into Call Desk Log.xlsx by calldesk_log_export.py (columns on each row + a "Vaccination details" sheet).

alter table calldesk.queue add column if not exists pitch text[];   -- Grooming / Vaccination / Consultation / Clinical, per list row

create table if not exists calldesk.pet_vacc_notes (
  phone text not null, pet_id text not null, pet_name text, note text not null,
  by_name text, updated_at timestamptz not null default now(),
  primary key (phone, pet_id));
alter table calldesk.pet_vacc_notes enable row level security;

create or replace function public.cd_pitch_save(p_id bigint, p_items text[])
 returns text[] language plpgsql security definer set search_path to 'calldesk', 'public'
as $f$
declare m calldesk.agents := calldesk.me(); q calldesk.queue; v text[];
begin
  select * into q from calldesk.queue where id = p_id and (agent_id = m.id or m.role = 'lead');
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select array_agg(x order by array_position(array['Grooming','Vaccination','Consultation','Clinical'], x)) into v
    from unnest(coalesce(p_items, '{}')) x where x in ('Grooming','Vaccination','Consultation','Clinical');
  update calldesk.queue set pitch = v, updated_at = now() where id = p_id;
  return coalesce(v, '{}');
end $f$;

create or replace function public.cd_vacc_note_save(p_phone text, p_pet_id text, p_note text, p_pet_name text default null)
 returns jsonb language plpgsql security definer set search_path to 'calldesk', 'public'
as $f$
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
end $f$;

-- what a customer card loads besides the list row: the pitch ticks + typed vaccination details per pet
create or replace function public.cd_card_extras(p_id bigint)
 returns jsonb language plpgsql stable security definer set search_path to 'calldesk', 'public'
as $f$
declare m calldesk.agents := calldesk.me(); q calldesk.queue;
begin
  select * into q from calldesk.queue where id = p_id and (agent_id = m.id or m.role = 'lead');
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('pitch', coalesce(to_jsonb(q.pitch), '[]'),
    'vacc', coalesce((select jsonb_object_agg(pet_id, jsonb_build_object('note', note, 'by', by_name, 'at', updated_at))
                        from calldesk.pet_vacc_notes where phone = q.phone), '{}'));
end $f$;
