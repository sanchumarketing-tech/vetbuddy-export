-- 30. Incentives page speed (19 Nov 2026).
-- cd_incentives sometimes took 4-9 s (over the 3 s limit of the web app's database login), so the page failed.
-- The slow part read a month of full VetBuddy sales lines (~45,000 wide rows) to find the pet visit days.
-- It now reads the same pet / day pairs from vetbuddy.mv_pbi_pet_day (7 MB, refreshed with the sales;
-- checked: same rows for November), and always plans with the real dates.
-- Same results (checked: Harshiya Nov booked 533 / visited 357 / eligible 263; Saranya Oct 457 / 302 / 235).
do $do$
declare d text := pg_get_functiondef('public.cd_incentives(date,integer)'::regprocedure);
  a text := 'sv as (select distinct substring(s.client_id from ''\(([^)]*)\)'') pid, s.sale_date from vetbuddy.sales s
          where s.sale_date >= f and s.sale_date < t + 4 and s.client_id is not null),';
  b text := 'sv as (select distinct substring(s.client_id from ''\(([^)]*)\)'') pid, s.sale_date from vetbuddy.mv_pbi_pet_day s
          where s.sale_date >= f and s.sale_date < t + 4),   -- 19-11-2026: pet-day summary (7 MB) instead of the full sales lines';
begin
  if position(a in d) = 0 then raise exception 'anchor not found'; end if;
  execute replace(d, a, b);
end $do$;
alter function public.cd_incentives(date,integer) set plan_cache_mode = force_custom_plan;
notify pgrst, 'reload schema';
