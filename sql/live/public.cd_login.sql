-- live definition of public.cd_login(p_user text, p_pin text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_login(p_user text, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public', 'extensions'
AS $function$
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
    update calldesk.agents set pin_hash = crypt(p_pin, gen_salt('bf')) where id = a.id;
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
end $function$
;
