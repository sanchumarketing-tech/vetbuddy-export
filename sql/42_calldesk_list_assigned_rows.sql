-- 26-11-2026 (applied live): an agent always sees the rows assigned to her, whatever their unit.
-- Since 24-11-2026 balance_lists gives Vet on Wheels agents check-ins of their parent clinic (e.g. Madurai VOW ->
-- MADURAI rows); cd_list / cd_list_live only showed rows of the agent's own units, so those rows were hidden
-- (Gomathi saw 3 of 201). Change in both functions:
--   (m.role = 'lead' or m.units = '{}' or q.unit = any (m.units))
-- -> (m.role = 'lead' or m.units = '{}' or q.unit = any (m.units) or q.agent_id = m.id)
do $x$ declare f text; d text; begin
  foreach f in array array['public.cd_list(date,integer)','public.cd_list_live(date,integer,timestamptz)'] loop
    d := pg_get_functiondef(f::regprocedure);
    if position('or q.agent_id = m.id)' in d) = 0 then
      execute replace(d, 'or q.unit = any (m.units))', 'or q.unit = any (m.units) or q.agent_id = m.id)');
    end if;
  end loop;
end $x$;
