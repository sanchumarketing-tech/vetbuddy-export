-- live definition of public.cd_pet_deceased_list(p_id bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_pet_deceased_list(p_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select coalesce(jsonb_agg(d.pet_id), '[]'::jsonb) from calldesk.queue q
    join calldesk.deceased_marked d on d.phone = q.phone
   where q.id = p_id and (calldesk.me()).id is not null
$function$
;
