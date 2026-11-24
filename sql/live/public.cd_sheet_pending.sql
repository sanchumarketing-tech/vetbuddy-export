-- live definition of public.cd_sheet_pending() - exported from the database
CREATE OR REPLACE FUNCTION public.cd_sheet_pending()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
begin
  if (calldesk.me()).id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'dnd', (select coalesce(jsonb_agg(jsonb_build_object('phone', phone, 'note', coalesce(nullif(note, ''), 'DND')) order by added_at), '[]')
              from calldesk.exclusions where reason = 'dnd' and sheet_at is null and coalesce(added_by, '') <> 'DND sheet'
               and added_at >= now() - interval '3 days'),
    'deceased', (select coalesce(jsonb_agg(jsonb_build_object('pet_id', pet_id, 'pet_name', pet_name, 'first_active', first_active,
                   'last_active', last_active, 'client_name', client_name, 'species', species, 'breed', breed,
                   'by', split_part(coalesce(marked_by, ''), '@', 1)) order by marked_at), '[]')
              from calldesk.deceased_marked where sheet_at is null and marked_at >= now() - interval '3 days'));
end $function$
;
