-- live definition of calldesk.exclusions_clean() - exported from the database
CREATE OR REPLACE FUNCTION calldesk.exclusions_clean()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare a int; b int;
begin
  delete from calldesk.queue q
   where q.list_date >= calldesk.today() and q.dialed_at is null and q.called_at is null and q.connected_at is null
     and q.outcome is null and q.note is null and exists (select 1 from calldesk.exclusions x where x.phone = q.phone);
  get diagnostics a = row_count;
  delete from calldesk.followups f where exists (select 1 from calldesk.exclusions x where x.phone = f.phone);
  get diagnostics b = row_count;
  return jsonb_build_object('rows_removed', a, 'followups_removed', b);
end $function$
;
