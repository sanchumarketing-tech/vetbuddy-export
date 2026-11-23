-- live definition of calldesk.deceased_clean(p_day date) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.deceased_clean(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare
  d date := coalesce(p_day, calldesk.today());
  n_f int; n_fd int; n_q int; n_qd int;
begin
  delete from calldesk.followups f
   where exists (select 1 from calldesk.deceased_map m where m.phone = f.phone and m.all_dead)
      or (f.phone in (select phone from calldesk.deceased_map) and f.reasons <> '[]'::jsonb
          and calldesk.deceased_strip(f.phone, f.reasons) = '[]'::jsonb);
  get diagnostics n_fd = row_count;
  with x as (select f.phone, f.reasons old, calldesk.deceased_strip(f.phone, f.reasons) new from calldesk.followups f
              where f.phone in (select phone from calldesk.deceased_map))
  update calldesk.followups f set reasons = x.new, updated_at = now() from x
   where f.phone = x.phone and x.new is distinct from x.old;
  get diagnostics n_f = row_count;
  with x as (select q.id, q.reasons r0, q.pets p0, calldesk.deceased_strip(q.phone, q.reasons) r1, calldesk.deceased_strip(q.phone, q.pets) p1
               from calldesk.queue q
              where q.list_date >= d and q.dialed_at is null and q.called_at is null and q.connected_at is null
                and q.outcome is null and q.note is null)
  update calldesk.queue q set reasons = x.r1, pets = x.p1 from x
   where q.id = x.id and (x.r1 is distinct from x.r0 or x.p1 is distinct from x.p0);
  get diagnostics n_q = row_count;
  delete from calldesk.queue q
   where q.list_date >= d and q.dialed_at is null and q.called_at is null and q.connected_at is null
     and q.outcome is null and q.note is null
     and (q.reasons = '[]'::jsonb or exists (select 1 from calldesk.deceased_map m where m.phone = q.phone and m.all_dead));
  get diagnostics n_qd = row_count;
  return jsonb_build_object('followups_cleaned', n_f, 'followups_removed', n_fd, 'rows_cleaned', n_q, 'rows_removed', n_qd);
end $function$
;
