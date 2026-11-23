-- live definition of public.cd_pet_deceased(p_id bigint, p_pet_id text, p_on boolean) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_pet_deceased(p_id bigint, p_pet_id text, p_on boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
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
end $function$
;
