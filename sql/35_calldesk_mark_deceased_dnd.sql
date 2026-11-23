-- 23 Nov 2026: agents mark a pet as deceased (pet card tick) and a number as DND (button by the number).
--
-- Deceased tick -> calldesk.deceased_marked (kept for good) + calldesk.deceased_pets / deceased_map at once,
--   so the pet is never called about from that moment (same rules as sql/34). deceased_apply() adds the
--   marked pets back after each morning's full VetBuddy reload. A sync job writes new marks as new lines in
--   "Deceased Pets Data.xlsx" (sheet_at = when written). Un-tick only before the line is written.
-- DND button -> calldesk.exclusions (reason 'dnd', the agent's reason in note) + the row closed as 'dnd'
--   (the same as the "Do not call" outcome). New DND numbers are written to the team's DND sheet (sheet_at).
-- Run as the admin (postgres).

alter table calldesk.deceased_pets add column if not exists source text not null default 'vetbuddy';

create table if not exists calldesk.deceased_marked (
  pet_id       text primary key,
  phone        text not null,
  pet_name     text,
  client_name  text,
  species      text,
  breed        text,
  unit         text,
  first_active date,
  last_active  date,
  marked_by    text,
  marked_at    timestamptz not null default now(),
  sheet_at     timestamptz
);
revoke all on calldesk.deceased_marked from public, anon, authenticated;
grant select, update on calldesk.deceased_marked to vb_loader;

alter table calldesk.exclusions add column if not exists sheet_at timestamptz;
grant select, update on calldesk.exclusions to vb_loader;

-- the number still has a living pet we know of?
create or replace function calldesk.deceased_phone_refresh(p_phone text)
 returns boolean language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare live boolean;
begin
  live := exists (select 1 from vetbuddy.sales s
                   where s.client_id is not null and calldesk.norm_phone(s.client_phone) = p_phone
                     and not exists (select 1 from calldesk.deceased_pets x where x.pet_id = substring(s.client_id from '\(([^)]*)\)')));
  update calldesk.deceased_map set all_dead = not live where phone = p_phone;
  return not live;
end $$;
revoke all on function calldesk.deceased_phone_refresh(text) from public, anon, authenticated;

-- tick / un-tick "Deceased" on a pet card of a list row
create or replace function public.cd_pet_deceased(p_id bigint, p_pet_id text, p_on boolean default true)
 returns jsonb language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare m calldesk.agents := calldesk.me(); q calldesk.queue; p jsonb; mk calldesk.deceased_marked; all_dead boolean;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into q from calldesk.queue where id = p_id and (agent_id = m.id or m.role = 'lead');
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select e into p from jsonb_array_elements(q.pets) e where e->>'pet_id' = p_pet_id limit 1;
  if p is null then raise exception 'pet not on this card'; end if;
  if p_on then
    insert into calldesk.deceased_marked (pet_id, phone, pet_name, client_name, species, breed, unit, first_active, last_active, marked_by)
    values (p_pet_id, q.phone, p->>'name', q.client, p->>'species', p->>'breed', coalesce(p->>'unit', q.unit),
            (p->>'first_visit')::date, (p->>'last_visit')::date, m.email)
    on conflict (pet_id) do nothing;
    insert into calldesk.deceased_pets (pet_id, pet_name, client_name, first_active, last_active, source)
    values (p_pet_id, p->>'name', q.client, p->>'first_visit', (p->>'last_visit')::date, 'calldesk')
    on conflict (pet_id) do nothing;
    insert into calldesk.deceased_map (phone, pet_id, pet_lc)
    select q.phone, p_pet_id, lower(trim(p->>'name'))
     where not exists (select 1 from calldesk.deceased_map x where x.phone = q.phone and x.pet_id = p_pet_id);
  else
    select * into mk from calldesk.deceased_marked where pet_id = p_pet_id;
    if mk.pet_id is null then raise exception 'this pet was marked deceased in VetBuddy - change it there'; end if;
    if mk.sheet_at is not null then raise exception 'already written to the Deceased sheet - ask the team lead'; end if;
    delete from calldesk.deceased_marked where pet_id = p_pet_id;
    delete from calldesk.deceased_pets where pet_id = p_pet_id and source = 'calldesk';
    delete from calldesk.deceased_map where pet_id = p_pet_id
       and not exists (select 1 from calldesk.deceased_pets x where x.pet_id = p_pet_id);
  end if;
  all_dead := calldesk.deceased_phone_refresh(q.phone);
  return jsonb_build_object('pet_id', p_pet_id, 'deceased', p_on, 'all_deceased', coalesce(all_dead, false));
end $$;
revoke all on function public.cd_pet_deceased(bigint, text, boolean) from public;
grant execute on function public.cd_pet_deceased(bigint, text, boolean) to anon, authenticated;   -- the app calls with the anon key + its session token (checked by calldesk.me())

-- which pets of the card were marked here (for the ticks)
create or replace function public.cd_pet_deceased_list(p_id bigint)
 returns jsonb language sql stable security definer set search_path to 'calldesk', 'public' as $$
  select coalesce(jsonb_agg(d.pet_id), '[]'::jsonb) from calldesk.queue q
    join calldesk.deceased_marked d on d.phone = q.phone
   where q.id = p_id and (calldesk.me()).id is not null
$$;
revoke all on function public.cd_pet_deceased_list(bigint) from public;
grant execute on function public.cd_pet_deceased_list(bigint) to anon, authenticated;

-- DND button: the number is never called again; the reason is kept
create or replace function public.cd_dnd(p_id bigint, p_reason text default null)
 returns void language plpgsql security definer set search_path to 'calldesk', 'public' as $$
begin
  perform public.cd_save(p_id, 'dnd', coalesce(nullif(trim(p_reason), ''), 'DND'), null);
end $$;
revoke all on function public.cd_dnd(bigint, text) from public;
grant execute on function public.cd_dnd(bigint, text) to anon, authenticated;

-- deceased_apply(): marked pets come back after the morning's full reload (patched in the live function:
--   after "begin"  + insert into calldesk.deceased_pets (...) select ... from calldesk.deceased_marked on conflict do nothing;)

-- calldesk_sheet_sync.py (vb_loader): numbers from the team's DND sheet are blocked, and their untouched rows
-- on today's and later lists leave at once (follow-ups too)
grant insert on calldesk.exclusions to vb_loader;
create or replace function calldesk.exclusions_clean()
 returns jsonb language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare a int; b int;
begin
  delete from calldesk.queue q
   where q.list_date >= calldesk.today() and q.dialed_at is null and q.called_at is null and q.connected_at is null
     and q.outcome is null and q.note is null and exists (select 1 from calldesk.exclusions x where x.phone = q.phone);
  get diagnostics a = row_count;
  delete from calldesk.followups f where exists (select 1 from calldesk.exclusions x where x.phone = f.phone);
  get diagnostics b = row_count;
  return jsonb_build_object('rows_removed', a, 'followups_removed', b);
end $$;
revoke all on function calldesk.exclusions_clean() from public, anon, authenticated;
grant execute on function calldesk.exclusions_clean() to vb_loader;

-- visible_ids / row_visible (patched live): a blocked number (exclusions) is not shown unless its row is closed
--   (coalesce(q.outcome, 'callback') <> 'callback' or not exists (select 1 from calldesk.exclusions x where x.phone = q.phone))
