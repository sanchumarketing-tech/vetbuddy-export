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
