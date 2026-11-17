-- =====================================================================
-- 18  Call Desk login (name / email + PIN) - no emails needed
--
--   The Python functions on Vercel (calldesk/api/*.py) call public.cd_login; it checks the PIN
--   (bcrypt) and returns a session token. The Python function keeps the token in an HttpOnly cookie
--   and sends it to Supabase as the header "x-cd-token" with every cd_* call.
--   calldesk.me() reads that header: no valid session = nothing is returned (cd_* raise 'not allowed').
--   An agent sees only their own list; a team lead sees everything.
--   5 wrong PINs lock the account for 15 minutes. Sessions last 12 hours.
--   First login of a TEAM LEAD with no PIN sets the PIN. Agents' PINs are set by the lead (Agents tab).
-- Safe to run again.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

alter table calldesk.agents add column if not exists pin_hash text;
alter table calldesk.agents add column if not exists failed int not null default 0;
alter table calldesk.agents add column if not exists locked_until timestamptz;

create table if not exists calldesk.sessions (
  token      text primary key,
  agent_id   int not null references calldesk.agents (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
revoke all on calldesk.sessions from public, anon, authenticated;

-- who is calling: the agent of the session token in the request header
create or replace function calldesk.me() returns calldesk.agents
language sql stable security definer set search_path = calldesk, public as $$
  select a from calldesk.sessions s join calldesk.agents a on a.id = s.agent_id
  where s.token = nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-cd-token', '')
    and s.expires_at > now() and a.active
  limit 1
$$;

create or replace function public.cd_login(p_user text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = calldesk, public, extensions as $$
declare a calldesk.agents; u text := lower(trim(coalesce(p_user, ''))); tok text;
begin
  select * into a from calldesk.agents
   where active and (email = u or lower(name) = u)
   order by (email = u) desc, id limit 1;
  if a.id is null then
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'msg', 'Wrong name / email or PIN.');
  end if;
  if a.locked_until > now() then
    return jsonb_build_object('ok', false, 'msg', 'Too many wrong PINs. Try again after ' ||
           to_char(a.locked_until at time zone 'Asia/Kolkata', 'HH12:MI am') || '.');
  end if;
  if coalesce(p_pin, '') !~ '^\d{4,8}$' then
    return jsonb_build_object('ok', false, 'msg', 'The PIN is 4 to 8 digits.');
  end if;
  if a.pin_hash is null then
    if a.role <> 'lead' then
      return jsonb_build_object('ok', false, 'msg', 'Your PIN is not set yet. Ask your team lead to set it in Agents.');
    end if;
    update calldesk.agents set pin_hash = crypt(p_pin, gen_salt('bf')) where id = a.id;   -- team lead: first login sets the PIN
  elsif a.pin_hash <> crypt(p_pin, a.pin_hash) then
    update calldesk.agents set failed = failed + 1,
           locked_until = case when failed + 1 >= 5 then now() + interval '15 minutes' end
     where id = a.id;
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'msg', 'Wrong name / email or PIN.');
  end if;
  update calldesk.agents set failed = 0, locked_until = null where id = a.id;
  delete from calldesk.sessions where expires_at < now();
  tok := encode(gen_random_bytes(32), 'hex');
  insert into calldesk.sessions (token, agent_id, expires_at) values (tok, a.id, now() + interval '12 hours');
  return jsonb_build_object('ok', true, 'token', tok, 'name', a.name, 'role', a.role);
end $$;

create or replace function public.cd_logout() returns void
language sql volatile security definer set search_path = calldesk, public as $$
  delete from calldesk.sessions
   where token = nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-cd-token', '')
$$;

-- team lead: add / change an agent, optionally set a new PIN ('' or null = keep)
drop function if exists public.cd_agent_save(text, text, text, text[], int, boolean);
create or replace function public.cd_agent_save(p_email text, p_name text, p_role text default 'agent',
    p_units text[] default '{}', p_target int default 200, p_active boolean default true, p_pin text default null) returns void
language plpgsql security definer set search_path = calldesk, public, extensions as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  if lower(trim(p_email)) = m.email and (p_role <> 'lead' or not p_active) then
    raise exception 'you cannot remove your own lead access';
  end if;
  if coalesce(p_pin, '') <> '' and p_pin !~ '^\d{4,8}$' then raise exception 'The PIN must be 4 to 8 digits'; end if;
  insert into calldesk.agents (email, name, role, units, daily_target, active, pin_hash)
  values (lower(trim(p_email)), trim(p_name), p_role, coalesce(p_units, '{}'), p_target, p_active,
          case when coalesce(p_pin, '') <> '' then crypt(p_pin, gen_salt('bf')) end)
  on conflict (email) do update set name = excluded.name, role = excluded.role, units = excluded.units,
                                    daily_target = excluded.daily_target, active = excluded.active,
                                    pin_hash = coalesce(excluded.pin_hash, calldesk.agents.pin_hash),
                                    failed = case when excluded.pin_hash is not null then 0 else calldesk.agents.failed end,
                                    locked_until = case when excluded.pin_hash is not null then null else calldesk.agents.locked_until end;
  if not p_active then delete from calldesk.sessions s using calldesk.agents a where a.id = s.agent_id and a.email = lower(trim(p_email)); end if;
end $$;

-- the Agents page shows whether a PIN is set
do $do$ declare s text; begin
  s := pg_get_functiondef('public.cd_team(date)'::regprocedure);
  if position('has_pin' in s) = 0 then
    if position('a.daily_target target, a.active,' in s) = 0 then raise exception 'cd_team anchor'; end if;
    s := replace(s, 'a.daily_target target, a.active,', 'a.daily_target target, a.active, a.pin_hash is not null as has_pin,');
    execute s;
  end if;
end $do$;

-- rights: the Python functions call with the anon key; every cd_* checks the session itself
revoke execute on function public.cd_login(text, text), public.cd_logout(),
  public.cd_agent_save(text, text, text, text[], int, boolean, text) from public;
grant execute on function public.cd_login(text, text), public.cd_logout(),
  public.cd_agent_save(text, text, text, text[], int, boolean, text) to anon, authenticated;


-- =====================================================================
-- 19  "Called - next customer" marks the row as called (who / when) + Excel call log (16 Nov 2026)
-- =====================================================================
alter table calldesk.queue add column if not exists called_at timestamptz;
alter table calldesk.queue add column if not exists called_by text;

create or replace function public.cd_mark_called(p_id bigint) returns jsonb
language plpgsql security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me(); q calldesk.queue;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.queue
     set called_at = now(), called_by = m.name, updated_at = now(),
         outcome = case when outcome = 'callback' and callback_at <= now() then null else outcome end   -- a due call-back is done
   where id = p_id and (agent_id = m.id or m.role = 'lead')
  returning * into q;
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('called_at', q.called_at, 'outcome', q.outcome, 'callback_at', q.callback_at);
end $$;

-- rows for the Excel call log (agent: own rows; lead: everyone or one agent)
create or replace function public.cd_log(p_from date, p_to date, p_agent int default -1) returns jsonb
language plpgsql stable security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.list_date, x.agent, x.id) from (
    select q.id, q.list_date, coalesce(a.name, '(not assigned)') agent, q.client, q.phone, q.unit,
           (select string_agg(e->>'label', ' | ' order by (e->>'rank')::int) from jsonb_array_elements(q.reasons) e) reasons,
           case when q.outcome = 'callback' and q.callback_at is not null then 'Rescheduled'
                when q.called_at is not null then 'Called' else 'Not called' end status,
           q.callback_at, q.called_at, q.called_by, q.note,
           q.attempted_at is not null logged_called, q.connected_at is not null logged_answered, q.last_call
      from calldesk.queue q left join calldesk.agents a on a.id = q.agent_id
     where q.list_date between p_from and p_to and not q.superseded
       and (m.role = 'lead' and (p_agent = -1 or q.agent_id = p_agent) or q.agent_id = m.id)) x), '[]');
end $$;
revoke execute on function public.cd_mark_called(bigint), public.cd_log(date, date, int) from public;
grant execute on function public.cd_mark_called(bigint), public.cd_log(date, date, int) to anon, authenticated;
-- cd_list also returns called_at / called_by; cd_team returns marked_called / rescheduled per agent (applied in place)


-- =====================================================================
-- 20  Team lead can switch call reasons off for a while (16 Nov 2026)
--   Switched-off reasons are hidden from the lists and the Excel log at once, and the next list
--   build does not add them. Switching back on shows them again (rows still on today's list come back).
-- =====================================================================
create table if not exists calldesk.reason_off (
  type    text primary key,
  off_by  text,
  off_at  timestamptz not null default now()
);
revoke all on calldesk.reason_off from public, anon, authenticated;

-- the reasons of a row without the switched-off ones (a promised call-back is never hidden)
create or replace function calldesk.strip_off(p jsonb) returns jsonb
language sql stable security definer set search_path = calldesk, public as $$
  select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(coalesce(p, '[]'::jsonb)) e
   where e->>'type' = 'callback' or not exists (select 1 from calldesk.reason_off o where o.type = e->>'type')
$$;

create or replace function public.cd_reason_set(p_type text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_type is null or p_type = 'callback' then raise exception 'this reason cannot be switched off'; end if;
  if p_on then delete from calldesk.reason_off where type = p_type;
  else insert into calldesk.reason_off (type, off_by) values (p_type, m.name) on conflict (type) do nothing; end if;
  return coalesce((select jsonb_agg(type order by type) from calldesk.reason_off), '[]');
end $$;
revoke execute on function public.cd_reason_set(text, boolean) from public;
grant execute on function public.cd_reason_set(text, boolean) to anon, authenticated;

do $do$ declare s text; begin
  -- the list: switched-off reasons removed, rows with nothing left hidden
  s := pg_get_functiondef('public.cd_list(date,int)'::regprocedure);
  if position('strip_off' in s) = 0 then
    if position($a$'reasons', q.reasons$a$ in s) = 0 or position('where q.list_date = coalesce(p_day, calldesk.today())' in s) = 0 then raise exception 'cd_list anchor'; end if;
    s := replace(s, $a$'reasons', q.reasons$a$, $a$'reasons', calldesk.strip_off(q.reasons)$a$);
    s := replace(s, 'where q.list_date = coalesce(p_day, calldesk.today())',
                    'where q.list_date = coalesce(p_day, calldesk.today()) and jsonb_array_length(calldesk.strip_off(q.reasons)) > 0');
    execute s;
  end if;
  -- the Excel log: the same rows the agents see
  s := pg_get_functiondef('public.cd_log(date,date,int)'::regprocedure);
  if position('strip_off' in s) = 0 then
    if position('where q.list_date between p_from and p_to and not q.superseded' in s) = 0 then raise exception 'cd_log anchor'; end if;
    s := replace(s, 'where q.list_date between p_from and p_to and not q.superseded',
                    'where q.list_date between p_from and p_to and not q.superseded and jsonb_array_length(calldesk.strip_off(q.reasons)) > 0');
    s := replace(s, 'from jsonb_array_elements(q.reasons) e) reasons', 'from jsonb_array_elements(calldesk.strip_off(q.reasons)) e) reasons');
    execute s;
  end if;
  -- the Team page: which reasons are off
  s := pg_get_functiondef('public.cd_team(date)'::regprocedure);
  if position('reasons_off' in s) = 0 then
    if position($a$'last_call_loaded',$a$ in s) = 0 then raise exception 'cd_team anchor'; end if;
    s := replace(s, $a$'last_call_loaded',$a$,
                 $a$'reasons_off', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'by', off_by, 'at', off_at) order by type), '[]') from calldesk.reason_off),
    'last_call_loaded',$a$);
    execute s;
  end if;
  -- the daily build: switched-off reasons are not added
  s := pg_get_functiondef('calldesk.build_list(date,boolean)'::regprocedure);
  if position('calldesk.reason_off' in s) = 0 then
    if position($a$delete from t_cand where type in ('lead', 'report_ready', 'birthday');$a$ in s) = 0 then raise exception 'build_list anchor'; end if;
    s := replace(s, $a$delete from t_cand where type in ('lead', 'report_ready', 'birthday');$a$,
                 $a$delete from t_cand where type in ('lead', 'report_ready', 'birthday');
  delete from t_cand where type in (select type from calldesk.reason_off);   -- switched off by the team lead$a$);
    execute s;
  end if;
end $do$;


-- =====================================================================
-- 21  Team lead switch: omit customers in the Corefactor call log from 9 Nov to 16 Nov 2026 (16 Nov 2026)
--   calldesk.settings 'skip_called' {"on", "from", "to", "source"}. When on: a number that is in the Corefactor
--   call log (any call, in or out) between "from" and "to" is hidden from the lists, the Excel log and the Team
--   counts, is not added by the daily build and is not carried over. Calls before "from" do not count.
--   Promised call-backs always show. Team page button: Omit Corefactor calls 9 Nov to 16 Nov.
-- =====================================================================
create table if not exists calldesk.settings (key text primary key, value jsonb not null, set_by text, set_at timestamptz not null default now());
revoke all on calldesk.settings from public, anon, authenticated;
insert into calldesk.settings (key, value, set_by)
values ('skip_called', '{"on": false, "from": "2026-11-09", "to": "2026-11-16", "source": "Corefactor"}', 'setup')
on conflict (key) do nothing;

create or replace function calldesk.omitted(p_phone text) returns boolean
language sql stable security definer set search_path = calldesk, public as $$
  select exists (select 1 from calldesk.settings s
                  where s.key = 'skip_called' and (s.value->>'on')::boolean
                    and exists (select 1 from calldesk.calls k
                                 where k.phone = p_phone and k.source = coalesce(s.value->>'source', 'Corefactor')
                                   and k.call_at >= (s.value->>'from')::date::timestamp
                                   and k.call_at < ((s.value->>'to')::date + 1)::timestamp))
$$;

create or replace function calldesk.row_visible(q calldesk.queue) returns boolean
language sql stable security definer set search_path = calldesk, public as $$
  select jsonb_array_length(calldesk.strip_off(q.reasons)) > 0 and (q.outcome = 'callback' or not calldesk.omitted(q.phone))
$$;

create or replace function public.cd_skip_called(p_on boolean) returns jsonb
language plpgsql security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.settings set value = jsonb_set(value, '{on}', to_jsonb(p_on)), set_by = m.name, set_at = now() where key = 'skip_called';
  return (select value || jsonb_build_object('by', set_by, 'at', set_at) from calldesk.settings where key = 'skip_called');
end $$;
revoke execute on function public.cd_skip_called(boolean) from public;
grant execute on function public.cd_skip_called(boolean) to anon, authenticated;

-- applied in place (16 Nov 2026):
--   cd_list, cd_log:  "jsonb_array_length(calldesk.strip_off(q.reasons)) > 0"  ->  "calldesk.row_visible(q)"
--   cd_team:          agent counts, by_reason and unassigned count only visible rows; returns skip_called and hidden_called
--   build_list:       after the reason_off delete:   delete from t_cand c where calldesk.omitted(c.phone);
--                     before the carry-over insert:  delete from t_carry c where c.outcome is distinct from 'callback' and calldesk.omitted(c.phone);


-- =====================================================================
-- 22  One pet's history for the Pets click box (17 Nov 2026): parent, location (units billed), vaccinations,
--     deworming and visits - straight from vetbuddy.sales
-- =====================================================================
create or replace function public.cd_pet(p_phone text, p_pet_id text) returns jsonb
language plpgsql stable security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null or (m.role <> 'lead' and not exists (
       select 1 from calldesk.queue q where q.phone = p_phone and q.agent_id = m.id and q.list_date >= calldesk.today() - 30))
  then raise exception 'not allowed' using errcode = '42501'; end if;
  return (
    with s as (
      select s.* from vetbuddy.sales s
       where calldesk.norm_phone(s.client_phone) = p_phone and substring(s.client_id from '\(([^)]*)\)') = p_pet_id)
    select jsonb_build_object(
      'pet', (select jsonb_build_object('name', s.patient_name, 'species', s.species, 'breed', s.breed, 'sex', nullif(s.patient_gender, '---'),
                     'dob', case when s.patient_dob_text ~ '^[A-Z][a-z]{2}, \d{2} \d{4}$' then to_date(s.patient_dob_text, 'Mon, DD YYYY') end,
                     'weight', (select s2.patient_weight_kg from s s2 where nullif(s2.patient_weight_kg::text, '') is not null and s2.patient_weight_kg::text <> '0' order by s2.sale_date desc limit 1),
                     'parent', s.client_name)
                from s order by s.sale_date desc limit 1),
      'units', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (select s.sales_unit unit, bool_or(coalesce(s.is_vow, false)) vow, count(distinct s.sale_date) n, max(s.sale_date) last from s group by 1) x),
      'first', (select min(sale_date) from s), 'last', (select max(sale_date) from s),
      'visit_days', (select count(distinct sale_date) from s), 'spend', (select round(sum(amount)) from s),
      'vaccines', (select coalesce(jsonb_agg(x order by x.sale_date desc), '[]') from (
          select s.sale_date, regexp_replace(s.item_name, '^Vaccination & Physical Examination - ', '') item, s.sales_unit unit, s.doctor
            from s where (s.plan_category ilike 'vaccination%' or s.item_name ~* 'vaccin|nobivac') and s.item_name !~* 'advice') x),
      'deworming', (select coalesce(jsonb_agg(x order by x.sale_date desc), '[]') from (
          select s.sale_date, s.item_name item, s.sales_unit unit from s where s.item_name ~* 'deworm' and s.item_name !~* 'advice') x),
      'visits', (select coalesce(jsonb_agg(x order by x.sale_date desc), '[]') from (
          select s.sale_date, min(s.sales_unit) unit, string_agg(distinct s.doctor, ', ') doctor,
                 array_agg(s.item_name order by s.amount desc nulls last) items, round(sum(s.amount)) amount
            from s group by s.sale_date order by s.sale_date desc limit 30) x))
  );
end $$;
revoke execute on function public.cd_pet(text, text) from public;
grant execute on function public.cd_pet(text, text) to anon, authenticated;
