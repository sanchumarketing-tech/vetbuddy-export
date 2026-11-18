-- live definition of public.cd_agent_save(p_email text, p_name text, p_role text, p_units text[], p_target integer, p_active boolean, p_pin text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_save(p_email text, p_name text, p_role text DEFAULT 'agent'::text, p_units text[] DEFAULT '{}'::text[], p_target integer DEFAULT 200, p_active boolean DEFAULT true, p_pin text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public', 'extensions'
AS $function$
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
end $function$
;
