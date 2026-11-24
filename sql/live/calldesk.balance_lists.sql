-- live definition of calldesk.balance_lists(d date) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.balance_lists(d date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare ag record; r record; a int; moved int := 0; waited int := 0; filled int := 0; extra int; need int; pp jsonb;
begin
  create temp table if not exists t_bal (id int primary key, units text[], target int, n int) on commit drop;
  truncate t_bal;
  -- only rows the agent can see count towards the target
  create temp table if not exists t_vis (id bigint primary key) on commit drop;
  truncate t_vis;
  insert into t_vis select distinct v.id from calldesk.visible_ids(d, d) v;
  insert into t_bal select g.id, g.units, g.daily_target,
         (select count(*) from calldesk.queue q where q.list_date = d and q.agent_id = g.id and q.id in (select id from t_vis))::int
    from calldesk.agents g where g.active and g.role = 'agent' and g.daily_target > 0 and g.department in (select name from calldesk.departments where calls);

  -- 1. over target: least urgent untouched rows move to an allowed agent with room, else wait as follow-ups
  for ag in select * from t_bal where n > target loop
    extra := ag.n - ag.target;
    for r in select q.id, q.phone, q.unit, q.reasons, q.carried_from, q.list_date from calldesk.queue q
              where q.list_date = d and q.agent_id = ag.id and q.called_at is null and q.dialed_at is null
                and q.attempted_at is null and q.skipped_at is null and coalesce(q.outcome, '') <> 'callback' and q.id in (select id from t_vis)
              order by q.rank desc, q.score asc nulls first, q.id desc limit extra loop
      select id into a from t_bal where n < target and id <> ag.id and (units = '{}' or r.unit = any (units))
       order by (units = '{}'), n::numeric / target, id limit 1;
      if a is not null then
        update calldesk.queue set agent_id = a where id = r.id;
        update t_bal set n = n + 1 where id = a;
        moved := moved + 1;
      elsif exists (select 1 from jsonb_array_elements(r.reasons) e where e->>'type' not in ('callback', 'followup', 'checkin')) then
        insert into calldesk.followups (phone, due, reasons, why, from_list)
        values (r.phone, d + 1, (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(r.reasons) e where e->>'type' not in ('callback', 'followup', 'checkin')),
                'waiting', coalesce(r.carried_from, r.list_date))
        on conflict (phone) do nothing;
        delete from calldesk.queue where id = r.id;
        waited := waited + 1;
      else
        delete from calldesk.queue where id = r.id;   -- a check-in only (filler): dropped, not parked
      end if;
      update t_bal set n = n - 1 where id = ag.id;
    end loop;
  end loop;

  -- 2. under target: unassigned rows of their units first
  for r in select q.id, q.unit from calldesk.queue q where q.list_date = d and q.agent_id is null and q.id in (select id from t_vis) order by q.rank, q.score desc loop
    select id into a from t_bal where n < target and (units = '{}' or r.unit = any (units)) order by (units = '{}'), n::numeric / target, id limit 1;
    continue when a is null;
    update calldesk.queue set agent_id = a where id = r.id;
    update t_bal set n = n + 1 where id = a;
  end loop;

  -- 2b. still under target: follow-ups waiting for room (same unit rules, not called yesterday), most urgent first
  for ag in select * from t_bal where n < target order by (units = '{}') loop
    need := ag.target - ag.n;
    for r in select f.phone, f.reasons, f.why, f.from_list, lq.client, lq.unit, lq.pets,
                    coalesce((select min((e->>'rank')::int) from jsonb_array_elements(f.reasons) e), 9) rk
               from calldesk.followups f
               join lateral (select q.client, q.unit, q.pets from calldesk.queue q where q.phone = f.phone order by q.list_date desc limit 1) lq on true
              where f.due <= d and (ag.units = '{}' or lq.unit = any (ag.units))
                and not exists (select 1 from calldesk.queue q where q.list_date = d and q.phone = f.phone)
                and not exists (select 1 from calldesk.exclusions x where x.phone = f.phone)
                and not exists (select 1 from calldesk.reason_off o where o.type = 'followup')
                and not calldesk.omitted(f.phone) and not calldesk.called_on(f.phone, d - 1)
              order by 8, f.due limit need loop
      insert into calldesk.queue (list_date, agent_id, phone, client, unit, rank, score, reasons, pets)
      values (d, ag.id, r.phone, r.client, r.unit, r.rk, 0,
              jsonb_build_array(jsonb_build_object('type', 'followup', 'rank', r.rk,
                'label', 'Follow-up - ' || case when r.why = 'called' then 'called on ' when r.why = 'waiting' then 'waiting since ' else 'no answer 3 times since ' end
                         || to_char(r.from_list, 'DD Mon') ||
                         coalesce(': ' || left((select string_agg(x.l, ' | ' order by x.r) from (select regexp_replace(regexp_replace(e->>'label', '\s+-\s+.*$', ''), '\s*\(.*$', '') l, min((e->>'rank')::int) r from jsonb_array_elements(r.reasons) e group by 1) x), 160), ''))),
              coalesce(r.pets, '[]'))
      on conflict (list_date, phone) do nothing;
      delete from calldesk.followups where phone = r.phone;
      update t_bal set n = n + 1 where id = ag.id;
      filled := filled + 1;
    end loop;
  end loop;

  -- 2c. (24 Nov 2026) Vet on Wheels agents still under target: unassigned customers of their parent clinic
  --     (calldesk.vow_parent) with a reason that can be done at home (calldesk.home_visit_reasons), most urgent first.
  --     Clinic agents get their unit's rows first (step 2), so this only takes what is left.
  for ag in select * from t_bal where n < target and exists (select 1 from calldesk.vow_parent v where v.vow_unit = any (units)) order by n::numeric / target, id loop
    need := ag.target - ag.n;
    with pick as (
      select q.id from calldesk.queue q
       where q.list_date = d and q.agent_id is null and q.id in (select id from t_vis)
         and calldesk.home_ok(ag.units, q.unit, q.reasons)
       order by q.rank, q.score desc nulls last, q.id limit need),
    upd as (update calldesk.queue q set agent_id = ag.id from pick where q.id = pick.id returning 1)
    select count(*) into extra from upd;
    update t_bal set n = n + extra where id = ag.id;
  end loop;

  -- 3. still under target: "Check-in" calls - active customers of their units, not on a list for 14 days, no call for 7 days
  if exists (select 1 from t_bal where n < target) and not exists (select 1 from calldesk.reason_off o where o.type = 'checkin') then
    create temp table if not exists t_chk (phone text primary key, client text, unit text, last date, spend numeric, used boolean default false) on commit drop;
    truncate t_chk;
    insert into t_chk (phone, client, unit, last, spend)
    select z.phone, z.client, z.unit, z.last, z.spend from (
      select calldesk.norm_phone(s.client_phone) phone, (array_agg(s.client_name order by s.sale_date desc))[1] client,
             (array_agg(s.sales_unit order by s.sale_date desc))[1] unit, max(s.sale_date) last, sum(s.amount) spend
        from vetbuddy.sales s where s.client_id is not null and s.sale_date >= d - 365 and s.sale_date < d
       group by 1) z
    where z.phone ~ '^[6-9]\d{9}$' and z.last between d - 365 and d - 21
      and not exists (select 1 from calldesk.exclusions x where x.phone = z.phone)
      and not exists (select 1 from calldesk.queue q where q.phone = z.phone and q.list_date between d - 14 and d)
      and not exists (select 1 from calldesk.followups f where f.phone = z.phone)
      and not exists (select 1 from calldesk.calls k where k.phone = z.phone and k.call_at >= (d - 7)::timestamp)
      and not calldesk.omitted(z.phone);
    -- (24 Nov 2026) clinic agents first; a Vet on Wheels agent also gets check-ins of its parent clinic (offer a home visit)
    for ag in select * from t_bal where n < target order by (units = '{}'), exists (select 1 from calldesk.vow_parent v where v.vow_unit = any (units)) loop
      need := ag.target - ag.n;
      for r in select c.* from t_chk c where not c.used and (ag.units = '{}' or c.unit = any (ag.units)
                       or c.unit in (select v.clinic_unit from calldesk.vow_parent v where v.vow_unit = any (ag.units)))
                order by (ag.units = '{}' or c.unit = any (ag.units)) desc, c.spend desc nulls last limit need loop
        select coalesce(jsonb_agg(p), '[]') into pp from (
          select jsonb_strip_nulls(jsonb_build_object('pet_id', x.pid, 'name', x.patient_name, 'species', x.species, 'breed', x.breed, 'last_visit', x.sale_date)) p
            from (select distinct on (substring(s2.client_id from '\(([^)]*)\)')) substring(s2.client_id from '\(([^)]*)\)') pid,
                         s2.patient_name, s2.species, s2.breed, s2.sale_date
                    from vetbuddy.sales s2 where calldesk.norm_phone(s2.client_phone) = r.phone and s2.sale_date >= d - 365
                   order by substring(s2.client_id from '\(([^)]*)\)'), s2.sale_date desc) x
           order by x.sale_date desc limit 6) y;
        insert into calldesk.queue (list_date, agent_id, phone, client, unit, rank, score, reasons, pets)
        values (d, ag.id, r.phone, r.client, r.unit, 12, coalesce(r.spend, 0),
                jsonb_build_array(jsonb_build_object('type', 'checkin', 'rank', 12,
                  'label', case when ag.units = '{}' or r.unit = any (ag.units)
                    then 'Check-in - last visit ' || to_char(r.last, 'DD Mon') || ' (' || (d - r.last) || ' days ago) - ask how the pet is, book the next visit'
                    else 'Check-in (Vet on Wheels) - last clinic visit ' || to_char(r.last, 'DD Mon') || ' (' || (d - r.last) || ' days ago) - ask how the pet is, offer a home visit' end)),
                pp)
        on conflict (list_date, phone) do nothing;
        update t_chk set used = true where phone = r.phone;
        update t_bal set n = n + 1 where id = ag.id;
        filled := filled + 1;
      end loop;
    end loop;
    -- 3b. still short ("Any" agents): older customers from before VetBuddy (Dec 2025), not seen since, unit unknown
    if exists (select 1 from t_bal where n < target and units = '{}') then
      create temp table if not exists t_new (phone text primary key) on commit drop;
      truncate t_new;
      insert into t_new select distinct calldesk.norm_phone(s.client_phone) from vetbuddy.sales s where s.client_phone is not null on conflict do nothing;
      for ag in select * from t_bal where n < target and units = '{}' order by id loop
        need := ag.target - ag.n;
        for r in select o.phone, o.client_name, o.last_date, o.last_pet, o.spend from vetbuddy.sales_old_summary o
                  where o.phone ~ '^[6-9]\d{9}$'
                    and not exists (select 1 from t_new n2 where n2.phone = o.phone)
                    and not exists (select 1 from calldesk.exclusions x where x.phone = o.phone)
                    and not exists (select 1 from calldesk.queue q where q.phone = o.phone and q.list_date between d - 30 and d)
                    and not exists (select 1 from calldesk.followups f where f.phone = o.phone)
                    and not exists (select 1 from calldesk.calls k where k.phone = o.phone and k.call_at >= (d - 30)::timestamp)
                    and not calldesk.omitted(o.phone)
                  order by o.last_date desc, o.spend desc nulls last limit need loop
          insert into calldesk.queue (list_date, agent_id, phone, client, unit, rank, score, reasons, pets)
          values (d, ag.id, r.phone, initcap(r.client_name), null, 13, coalesce(r.spend, 0),
                  jsonb_build_array(jsonb_build_object('type', 'checkin', 'rank', 13,
                    'label', 'Check-in (old customer) - last visit ' || to_char(r.last_date, 'DD Mon YYYY') || coalesce(' with ' || initcap(r.last_pet), '') || ' - invite them back')),
                  case when r.last_pet is not null then jsonb_build_array(jsonb_build_object('name', initcap(r.last_pet), 'last_visit', r.last_date)) else '[]'::jsonb end)
          on conflict (list_date, phone) do nothing;
          if found then update t_bal set n = n + 1 where id = ag.id; filled := filled + 1; end if;
        end loop;
      end loop;
    end if;
  end if;
  return jsonb_build_object('moved', moved, 'waiting', waited, 'checkin_added', filled,
                            'short', (select coalesce(jsonb_object_agg(g.name, b.target - b.n), '{}') from t_bal b join calldesk.agents g on g.id = b.id where b.n < b.target));
end $function$
;
