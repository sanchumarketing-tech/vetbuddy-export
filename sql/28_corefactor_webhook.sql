-- 28. Corefactor live calls (webhook), 18 Nov 2026.
-- Corefactor pushes every call to https://ykmgbuooksizjqsyfhut.supabase.co/functions/v1/corefactor/calls?key=<key>
-- The Supabase Edge Function "corefactor" (supabase/functions/corefactor) passes the body to public.cf_webhook(key, body):
--   * every push is kept as it came in calldesk.cf_live_raw (so nothing is lost while the field names are confirmed)
--   * when the push has a phone number and a call time it is also saved to calldesk.calls (source 'Corefactor',
--     the same table the daily call-log job fills), so the Call Desk sees the call straight away.
--     The daily job still runs and fills in anything missed. When it saves a call, the trigger below removes the
--     live copy of the same call (same number, within 3 minutes), so a call is never counted twice.
-- The key lives in calldesk.webhook_keys (no grants: only this function reads it).

create table if not exists calldesk.webhook_keys (name text primary key, key text not null, created_at timestamptz not null default now());
create table if not exists calldesk.cf_live_raw (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  body jsonb not null,
  saved boolean not null default false,
  note text
);
create index if not exists cf_live_raw_at on calldesk.cf_live_raw (received_at);
revoke all on calldesk.webhook_keys, calldesk.cf_live_raw from public, anon, authenticated;

create or replace function public.cf_webhook(p_key text, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = calldesk, public as $$
declare
  b jsonb := coalesce(p_body, '{}'::jsonb);
  v_id bigint; v_phone text; v_at timestamp; v_dir text; v_status text; v_agent text; v_dur int; v_talk int;
  pick text;
begin
  if p_key is null or not exists (select 1 from webhook_keys where name = 'corefactor_calls' and key = p_key) then
    return jsonb_build_object('ok', false, 'message', 'bad key');
  end if;
  -- some systems wrap the call in "data" / "call" / an array
  if jsonb_typeof(b) = 'array' then b := b -> 0; end if;
  if b ? 'data' and jsonb_typeof(b -> 'data') = 'object' then b := b || (b -> 'data'); end if;
  if b ? 'call' and jsonb_typeof(b -> 'call') = 'object' then b := b || (b -> 'call'); end if;
  insert into cf_live_raw (body) values (p_body) returning id into v_id;

  -- field names vary between Corefactor accounts: take the first one present (case-insensitive)
  with kv as (select lower(regexp_replace(key, '[^A-Za-z0-9]', '', 'g')) k, value #>> '{}' v from jsonb_each(b))
  select
    right(regexp_replace(coalesce(
      (select v from kv where k in ('customernumber','customerphone','customer','callernumber','caller','callerid','from','mobile','phone','phonenumber','clientnumber','destination','to') and v ~ '\d{10}' limit 1), ''), '\D', '', 'g'), 10),
    (select v from kv where k in ('starttime','callstarttime','calldate','calltime','createdat','datetime','timestamp','time','date') and v <> '' limit 1),
    (select v from kv where k in ('calltype','direction','type') limit 1),
    (select v from kv where k in ('callstatus','status','disposition','callresult') limit 1),
    (select v from kv where k in ('agentname','agent','agentid','username','user') limit 1),
    (select case when v ~ '^\d+$' then v::int when v ~ '^\d+:\d+:\d+$' then extract(epoch from v::interval)::int end from kv where k in ('totaltime','duration','callduration','totalduration') limit 1),
    (select case when v ~ '^\d+$' then v::int when v ~ '^\d+:\d+:\d+$' then extract(epoch from v::interval)::int end from kv where k in ('talktime','billsec','conversationduration','talkduration') limit 1)
  into v_phone, pick, v_dir, v_status, v_agent, v_dur, v_talk;

  begin
    if pick ~ '^\d{10,13}$' then           -- unix seconds / milliseconds
      v_at := (to_timestamp(case when length(pick) > 10 then pick::bigint / 1000 else pick::bigint end) at time zone 'Asia/Kolkata');
    elsif pick is not null then
      v_at := pick::timestamptz at time zone 'Asia/Kolkata';
      if pick !~ '([+-]\d\d:?\d\d|Z)$' then v_at := pick::timestamp; end if;   -- no zone given: already IST
    end if;
  exception when others then v_at := null;
  end;

  if length(v_phone) = 10 and v_at is not null then
    insert into calls (source, call_key, call_at, phone, direction, call_type, status, answered, duration_s, agent, talk_s,
                       customer_name, disposition, campaign, recording, notes)
    values ('Corefactor', 'live:' || md5(b::text), v_at, v_phone,
            case when v_dir ilike '%in%' then 'in' when v_dir ilike '%out%' then 'out' else '?' end,
            v_dir, v_status,
            coalesce(v_status ilike 'answered%' or v_status ilike 'connected%' or v_status ilike 'completed%', false) and coalesce(v_talk, v_dur, 0) >= 15,
            v_dur, v_agent, v_talk,
            (select value #>> '{}' from jsonb_each(b) where lower(key) in ('customername','name','leadname') limit 1),
            (select value #>> '{}' from jsonb_each(b) where lower(regexp_replace(key,'[^A-Za-z]','','g')) in ('calldisposition','disposition') limit 1),
            (select value #>> '{}' from jsonb_each(b) where lower(regexp_replace(key,'[^A-Za-z]','','g')) in ('campaignname','campaign') limit 1),
            (select value #>> '{}' from jsonb_each(b) where lower(regexp_replace(key,'[^A-Za-z]','','g')) in ('recordingurl','recording','recordurl','recordinglink') limit 1),
            (select value #>> '{}' from jsonb_each(b) where lower(key) in ('notes','remarks','comment','comments') limit 1))
    on conflict (source, call_key) do nothing;
    update cf_live_raw set saved = true where id = v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'saved', true);
  end if;
  update cf_live_raw set note = 'kept raw: no phone / time found' where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'saved', false);
end $$;
revoke all on function public.cf_webhook(text, jsonb) from public;
grant execute on function public.cf_webhook(text, jsonb) to anon;

create or replace function public.cf_webhook_ping(p_key text) returns boolean
language sql security definer set search_path = calldesk as $$
  select exists (select 1 from webhook_keys where name = 'corefactor_calls' and key = p_key)
$$;
revoke all on function public.cf_webhook_ping(text) from public;
grant execute on function public.cf_webhook_ping(text) to anon;


-- the daily Corefactor file replaces the live copy of the same call
create or replace function calldesk.cf_live_dedupe() returns trigger language plpgsql as $$
begin
  if new.source = 'Corefactor' and new.call_key not like 'live:%' then
    delete from calldesk.calls
     where source = 'Corefactor' and call_key like 'live:%' and phone = new.phone
       and call_at between new.call_at - interval '3 minutes' and new.call_at + interval '3 minutes';
  end if;
  return null;
end $$;
drop trigger if exists calls_cf_live_dedupe on calldesk.calls;
create trigger calls_cf_live_dedupe after insert on calldesk.calls
  for each row execute function calldesk.cf_live_dedupe();

notify pgrst, 'reload schema';
