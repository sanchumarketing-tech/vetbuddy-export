-- live definition of public.cd_sheet_done(p_phones text[], p_pets text[]) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_sheet_done(p_phones text[] DEFAULT '{}'::text[], p_pets text[] DEFAULT '{}'::text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
begin
  if (calldesk.me()).id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.exclusions set sheet_at = now() where phone = any(p_phones) and sheet_at is null;
  update calldesk.deceased_marked set sheet_at = now() where pet_id = any(p_pets) and sheet_at is null;
end $function$
;
