-- live definition of calldesk.norm_phone(v text) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.norm_phone(v text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when length(regexp_replace(coalesce(v, ''), '\D', '', 'g')) >= 10
              then right(regexp_replace(v, '\D', '', 'g'), 10) end
$function$
;
