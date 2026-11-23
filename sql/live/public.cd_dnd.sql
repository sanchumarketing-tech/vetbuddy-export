-- live definition of public.cd_dnd(p_id bigint, p_reason text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_dnd(p_id bigint, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
begin
  perform public.cd_save(p_id, 'dnd', coalesce(nullif(trim(p_reason), ''), 'DND'), null);
end $function$
;
