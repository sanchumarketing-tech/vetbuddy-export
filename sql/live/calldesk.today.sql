-- live definition of calldesk.today() - exported from the database
CREATE OR REPLACE FUNCTION calldesk.today()
 RETURNS date
 LANGUAGE sql
 STABLE
AS $function$ select (now() at time zone 'Asia/Kolkata')::date $function$
;
