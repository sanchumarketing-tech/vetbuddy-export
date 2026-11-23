-- live definition of calldesk.deceased_phone_refresh(p_phone text) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.deceased_phone_refresh(p_phone text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare live boolean;
begin
  live := exists (select 1 from vetbuddy.sales s
                   where s.client_id is not null and calldesk.norm_phone(s.client_phone) = p_phone
                     and not exists (select 1 from calldesk.deceased_pets x where x.pet_id = substring(s.client_id from '\(([^)]*)\)')));
  update calldesk.deceased_map set all_dead = not live where phone = p_phone;
  return not live;
end $function$
;
