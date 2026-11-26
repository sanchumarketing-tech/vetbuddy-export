-- live definition of public.cd_calls(p_phone text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_calls(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null or (m.role <> 'lead' and not exists (
       select 1 from calldesk.queue q where q.phone = p_phone and q.agent_id = m.id and q.list_date >= calldesk.today() - 30))
  then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.call_at desc) from (
    (select k.call_at, k.source, k.direction, k.status, k.answered, k.duration_s, k.talk_s, k.agent,
           k.disposition, k.notes, k.dtmf, k.campaign, k.recording
      from calldesk.calls k where k.phone = p_phone order by k.call_at desc limit 15)
    union all
    -- 24 Nov 2026: the agent's own "called" mark in Call Desk (shows even before the Corefactor call arrives)
    (select (q.called_at at time zone 'Asia/Kolkata'), 'Call Desk', 'note', 'Marked called', null, null, null, coalesce(q.called_by, a.name),
            nullif(concat_ws(' · ', case when q.outcome is not null then 'Outcome: ' || q.outcome end), ''), nullif(q.note, ''), null, null, null
       from calldesk.queue q left join calldesk.agents a on a.id = q.agent_id
      where q.phone = p_phone and q.called_at is not null and q.list_date >= calldesk.today() - 30 order by q.called_at desc limit 5)
    union all
    -- the agent's comment is kept in the Corefactor Lead Box (CRM), not in the call log
    (select l.created_at, 'Lead Box', 'note', nullif(concat_ws(' / ', l.raw->>'Call Status', l.raw->>'Sub Status'), ''), null, null, null,
           l.raw->>'Lead Owner',
           nullif(concat_ws(' · ', nullif(l.raw->>'Purpose of Calling', ''),
                  'Appointment: ' || nullif(l.raw->>'Appointment Status', ''),
                  'Lead: ' || nullif(l.raw->>'Lead Status', '')), ''),
           nullif(l.raw->>'Comments', ''), null, null, null
      from calldesk.leads l where l.phone = p_phone order by l.created_at desc limit 10)) x), '[]');
end $function$
;
