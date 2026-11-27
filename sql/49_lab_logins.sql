-- =====================================================================
-- 49  Lab Follow-up: its own logins, agents, team view and call notes (27 Nov 2026)
--
--   Like the Call Desk, but a separate list of people (unit CRM staff etc.):
--   lab.agents    name / email / role (agent or lead) / units / PIN (bcrypt) / active
--   lab.sessions  12-hour sessions; the website keeps the token in an HttpOnly cookie and sends it as the
--                 header "x-lf-token". lab.me() = the signed-in person (nothing for a wrong / old token).
--   lab.notes     what the caller wrote about a number: outcome, call-back date, note.
--   Agents see only their units (no units = every unit); team leads see everything and manage Agents.
--   First login of a team lead with no PIN sets the PIN. 5 wrong PINs lock the login for 15 minutes.
--   The three Call Desk team leads are copied once (with their PINs) so someone can sign in and add agents;
--   after that the two lists are separate.
-- Safe to run again.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists lab.agents (
  id           serial primary key,
  email        text not null unique,
  name         text not null,
  role         text not null default 'agent' check (role in ('agent', 'lead')),
  units        text[] not null default '{}',
  active       boolean not null default true,
  pin_hash     text,
  failed       int not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  created_by   text
);

create table if not exists lab.sessions (
  token      text primary key,
  agent_id   int not null references lab.agents (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists lab.notes (
  id            bigserial primary key,
  vb_key        text not null,           -- the pet ("<client> (<pet>)")
  last_report   date,                    -- the report it was about
  phone         text,
  unit          text,
  outcome       text not null,
  callback_date date,
  note          text,
  agent_id      int references lab.agents (id),
  agent_name    text,
  created_at    timestamptz not null default now()
);
create index if not exists notes_key on lab.notes (vb_key, created_at desc);
create index if not exists notes_at on lab.notes (created_at);

revoke all on all tables in schema lab from public, anon, authenticated;

insert into lab.agents (email, name, role, units, active, pin_hash, created_by)
select lower(email), name, 'lead', units, true, pin_hash, 'copied from Call Desk'
from calldesk.agents where role = 'lead' and active and deleted_at is null
on conflict (email) do nothing;

create or replace function lab.me() returns lab.agents
language sql stable security definer set search_path = lab, public as $$
  select a from lab.sessions s join lab.agents a on a.id = s.agent_id
  where s.token = nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-lf-token', '')
    and s.expires_at > now() and a.active
  limit 1
$$;

create or replace function lab.must_lead() returns lab.agents
language plpgsql stable security definer set search_path = lab, public as $$
declare m lab.agents := lab.me();
begin
  if m.id is null or m.role <> 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  return m;
end $$;

create or replace function public.lf_login(p_user text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = lab, public, extensions as $$
declare a lab.agents; u text := lower(trim(coalesce(p_user, ''))); tok text;
begin
  select * into a from lab.agents where active and (email = u or lower(name) = u)
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
    update lab.agents set pin_hash = crypt(p_pin, gen_salt('bf')) where id = a.id;   -- team lead: first login sets the PIN
  elsif a.pin_hash <> crypt(p_pin, a.pin_hash) then
    update lab.agents set failed = failed + 1,
           locked_until = case when failed + 1 >= 5 then now() + interval '15 minutes' end
     where id = a.id;
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'msg', 'Wrong name / email or PIN.');
  end if;
  update lab.agents set failed = 0, locked_until = null where id = a.id;
  delete from lab.sessions where expires_at < now();
  tok := encode(gen_random_bytes(32), 'hex');
  insert into lab.sessions (token, agent_id, expires_at) values (tok, a.id, now() + interval '12 hours');
  return jsonb_build_object('ok', true, 'token', tok, 'name', a.name, 'role', a.role);
end $$;

create or replace function public.lf_logout() returns void
language sql volatile security definer set search_path = lab, public as $$
  delete from lab.sessions
   where token = nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-lf-token', '')
$$;

create or replace function public.lf_me() returns jsonb
language sql stable security definer set search_path = lab, public as $$
  select case when m.id is null then null
         else jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'role', m.role, 'units', m.units) end
  from (select (lab.me()).*) m
$$;

-- the board: open list (agents: their units) + unit counts + latest note per pet + today's notes per agent
create or replace function public.lf_board() returns jsonb
language plpgsql stable security definer set search_path = lab, public as $$
declare
  a lab.agents := lab.me();
  today date := (now() at time zone 'Asia/Kolkata')::date;
  units text[];
begin
  if a.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  units := case when a.role = 'lead' or cardinality(a.units) = 0 then null else a.units end;
  return jsonb_build_object(
    'me', jsonb_build_object('id', a.id, 'name', a.name, 'role', a.role, 'units', a.units),
    'today', today,
    'vetbuddy_to', (select date_to from vetbuddy.v_data_freshness limit 1),
    'tracker_last', (select max(report_date) from lab.reports),
    'built_at', (select max(built_at) from lab.board),
    'start_date', (select value from lab.settings where key = 'start_date'),
    'rows', coalesce((
      select jsonb_agg((to_jsonb(b) - 'built_at') || jsonb_build_object(
               'note', (select jsonb_build_object('outcome', n.outcome, 'callback_date', n.callback_date, 'note', n.note,
                                                  'by', n.agent_name, 'at', n.created_at)
                          from lab.notes n where n.vb_key = b.vb_key order by n.created_at desc limit 1),
               'notes_n', (select count(*) from lab.notes n where n.vb_key = b.vb_key))
             order by b.unit, b.last_report desc, b.pet_name)
      from lab.board b where units is null or b.unit = any (units)), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(u order by u ->> 'unit') from (
        select jsonb_build_object(
          'unit', x.unit,
          'yesterday', count(*) filter (where x.report_date = today - 1),
          'open', (select count(*) from lab.board b where b.unit = x.unit),
          'back_yday', (select count(*) from lab.done d where d.unit = x.unit and d.visit_date = today - 1),
          'back_7d', (select count(*) from lab.done d where d.unit = x.unit and d.visit_date >= today - 7),
          'notes_today', (select count(*) from lab.notes n where n.unit = x.unit
                            and (n.created_at at time zone 'Asia/Kolkata')::date = today)) u
        from (select unit, report_date from lab.reports where report_date >= today - 1
              union all select unit, null from lab.board
              union all select unit, null from lab.done where visit_date >= today - 7) x
        where x.unit is not null and (units is null or x.unit = any (units))
        group by x.unit) q), '[]'::jsonb),
    -- team view (leads): each agent's notes today
    'agents', case when a.role = 'lead' then coalesce((
        select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'role', g.role, 'units', g.units,
                 'notes_today', (select count(*) from lab.notes n where n.agent_id = g.id
                                   and (n.created_at at time zone 'Asia/Kolkata')::date = today),
                 'informed_today', (select count(*) from lab.notes n where n.agent_id = g.id and n.outcome in ('Informed', 'Will visit')
                                   and (n.created_at at time zone 'Asia/Kolkata')::date = today),
                 'last_note', (select max(n.created_at) from lab.notes n where n.agent_id = g.id))
               order by g.role desc, g.name)
        from lab.agents g where g.active), '[]'::jsonb) end);
end $$;

create or replace function public.lf_note_save(p_vb_key text, p_outcome text, p_callback date default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer set search_path = lab, public as $$
declare a lab.agents := lab.me(); b lab.board;
begin
  if a.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from lab.board where vb_key = p_vb_key;
  if b.vb_key is null then raise exception 'This pet is no longer on the list.'; end if;
  if a.role <> 'lead' and cardinality(a.units) > 0 and not (b.unit = any (a.units)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(trim(p_outcome), '') = '' then raise exception 'Choose what happened on the call.'; end if;
  insert into lab.notes (vb_key, last_report, phone, unit, outcome, callback_date, note, agent_id, agent_name)
  values (b.vb_key, b.last_report, b.phone, b.unit, left(trim(p_outcome), 60), p_callback, nullif(left(trim(coalesce(p_note, '')), 1000), ''),
          a.id, a.name);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.lf_notes(p_vb_key text) returns jsonb
language plpgsql stable security definer set search_path = lab, public as $$
declare a lab.agents := lab.me();
begin
  if a.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('outcome', outcome, 'callback_date', callback_date, 'note', note,
                                   'by', agent_name, 'at', created_at, 'report', last_report) order by created_at desc)
                   from lab.notes where vb_key = p_vb_key
                     and (a.role = 'lead' or cardinality(a.units) = 0 or unit = any (a.units))), '[]'::jsonb);
end $$;

-- Agents tab (team leads)
create or replace function public.lf_agents() returns jsonb
language plpgsql stable security definer set search_path = lab, public as $$
begin
  perform lab.must_lead();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'email', email, 'name', name, 'role', role, 'units', units,
                                   'active', active, 'has_pin', pin_hash is not null,
                                   'locked', locked_until > now()) order by role desc, name)
                   from lab.agents), '[]'::jsonb);
end $$;

create or replace function public.lf_agent_save(p_id int, p_email text, p_name text, p_role text, p_units text[],
                                                p_active boolean, p_pin text default null) returns jsonb
language plpgsql volatile security definer set search_path = lab, public, extensions as $$
declare m lab.agents := lab.must_lead(); e text := lower(trim(coalesce(p_email, ''))); nid int;
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter a name.'; end if;
  if p_role not in ('agent', 'lead') then raise exception 'Role must be agent or team lead.'; end if;
  if p_pin is not null and p_pin <> '' and p_pin !~ '^\d{4,8}$' then raise exception 'The PIN is 4 to 8 digits.'; end if;
  if p_id = m.id and (not p_active or p_role <> 'lead') then raise exception 'You cannot remove your own team lead access.'; end if;
  if exists (select 1 from lab.agents where (email = e or lower(name) = lower(trim(p_name))) and id is distinct from p_id) then
    raise exception 'Another login already has this name or email.';
  end if;
  if p_id is null then
    if coalesce(p_pin, '') = '' then raise exception 'Set a PIN for the new login.'; end if;
    insert into lab.agents (email, name, role, units, active, pin_hash, created_by)
    values (e, trim(p_name), p_role, coalesce(p_units, '{}'), p_active, crypt(p_pin, gen_salt('bf')), m.name)
    returning id into nid;
  else
    update lab.agents set email = e, name = trim(p_name), role = p_role, units = coalesce(p_units, '{}'), active = p_active,
           pin_hash = case when coalesce(p_pin, '') <> '' then crypt(p_pin, gen_salt('bf')) else pin_hash end,
           failed = case when coalesce(p_pin, '') <> '' then 0 else failed end,
           locked_until = case when coalesce(p_pin, '') <> '' then null else locked_until end
     where id = p_id returning id into nid;
    if nid is null then raise exception 'Login not found.'; end if;
    if not p_active then delete from lab.sessions where agent_id = nid; end if;   -- inactive: signed out at once
  end if;
  return jsonb_build_object('ok', true, 'id', nid);
end $$;

revoke all on function lab.me(), lab.must_lead() from public, anon, authenticated;
revoke all on function public.lf_login(text, text), public.lf_logout(), public.lf_me(), public.lf_board(),
  public.lf_note_save(text, text, date, text), public.lf_notes(text), public.lf_agents(),
  public.lf_agent_save(int, text, text, text, text[], boolean, text) from public;
grant execute on function public.lf_login(text, text), public.lf_logout(), public.lf_me(), public.lf_board(),
  public.lf_note_save(text, text, date, text), public.lf_notes(text), public.lf_agents(),
  public.lf_agent_save(int, text, text, text, text[], boolean, text) to anon, authenticated;
