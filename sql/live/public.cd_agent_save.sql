-- live definition of public.cd_agent_save(p_email text, p_name text, p_role text, p_units text[], p_target integer, p_active boolean, p_pin text, p_id integer, p_department text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_save(p_email text, p_name text, p_role text DEFAULT 'agent'::text, p_units text[] DEFAULT '{}'::text[], p_target integer DEFAULT 200, p_active boolean DEFAULT true, p_pin text DEFAULT NULL::text, p_id integer DEFAULT NULL::integer, p_department text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public', 'extensions'
AS $function$
declare m calldesk.agents := calldesk.me(); v_email text := lower(trim(p_email)); other text; v_dept text := nullif(trim(coalesce(p_department, '')), '');
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  if (v_email = m.email or p_id = m.id) and (p_role <> 'lead' or not p_active) then
    raise exception 'you cannot remove your own lead access';
  end if;
  if coalesce(p_pin, '') <> '' and p_pin !~ '^\d{4,8}$' then raise exception 'The PIN must be 4 to 8 digits'; end if;
  if v_dept is not null and not exists (select 1 from calldesk.departments where name = v_dept) then raise exception 'Unknown department %', v_dept; end if;
  if p_id is not null then
    -- edit: the same agent keeps their id, list and history; name and email can change
    if not exists (select 1 from calldesk.agents where id = p_id) then raise exception 'This agent no longer exists - reload the page'; end if;
    select name into other from calldesk.agents where email = v_email and id <> p_id;
    if other is not null then raise exception 'The email % is already used by %', v_email, other; end if;
    update calldesk.agents set email = v_email, name = trim(p_name), role = p_role, units = coalesce(p_units, '{}'),
           daily_target = p_target, active = p_active,
           department = case when p_department is null then department else v_dept end,
           pin_hash = case when coalesce(p_pin, '') <> '' then crypt(p_pin, gen_salt('bf')) else pin_hash end,
           failed = case when coalesce(p_pin, '') <> '' then 0 else failed end,
           locked_until = case when coalesce(p_pin, '') <> '' then null else locked_until end
     where id = p_id;
  else
    insert into calldesk.agents (email, name, role, units, daily_target, active, department, pin_hash)
    values (v_email, trim(p_name), p_role, coalesce(p_units, '{}'), p_target, p_active, v_dept,
            case when coalesce(p_pin, '') <> '' then crypt(p_pin, gen_salt('bf')) end)
    on conflict (email) do update set name = excluded.name, role = excluded.role, units = excluded.units,
                                      daily_target = excluded.daily_target, active = excluded.active,
                                      department = coalesce(excluded.department, calldesk.agents.department),
                                      pin_hash = coalesce(excluded.pin_hash, calldesk.agents.pin_hash),
                                      failed = case when excluded.pin_hash is not null then 0 else calldesk.agents.failed end,
                                      locked_until = case when excluded.pin_hash is not null then null else calldesk.agents.locked_until end;
  end if;
  if not p_active then
    delete from calldesk.sessions s using calldesk.agents a where a.id = s.agent_id and (a.id = p_id or a.email = v_email);
  end if;
  -- (20 Nov 2026) today's list follows the change at once: a new agent gets numbers of their units; a team lead,
  -- an inactive agent or an agent of a non-calling department gives theirs back
  begin
    perform calldesk.rebalance_today();
  exception when others then
    raise warning 'rebalance_today failed: %', sqlerrm;
  end;
end $function$
;
