-- 29. Corefactor Lead Box pushed live (webhook), 18 Nov 2026.
-- 18 Nov 2026: NOT USED - Lead Box comes through Corefactor's API instead. The function stays, but anon can no longer call it.
-- Corefactor pushes each new / updated lead to https://ykmgbuooksizjqsyfhut.supabase.co/functions/v1/corefactor/leads?key=<key>
-- (same key as the call webhook). public.cf_lead_webhook keeps the raw push in calldesk.cf_live_raw (kind 'lead')
-- and saves the lead to calldesk.leads (the table the daily Lead Box job fills). A later push for the same
-- lead id updates its status. When the daily Lead Box file loads the same lead, the live copy is removed.

alter table calldesk.cf_live_raw add column if not exists kind text not null default 'call';

create or replace function public.cf_lead_webhook(p_key text, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = calldesk, public as $$
declare
  b jsonb := coalesce(p_body, '{}'::jsonb);
  v_id bigint; v_phone text; v_at timestamp; v_lid text; v_t text;
  v_name text; v_purpose text; v_status text; v_unit text;
begin
  if p_key is null or not exists (select 1 from webhook_keys where name = 'corefactor_calls' and key = p_key) then
    return jsonb_build_object('ok', false, 'message', 'bad key');
  end if;
  if jsonb_typeof(b) = 'array' then b := b -> 0; end if;
  if b ? 'data' and jsonb_typeof(b -> 'data') = 'object' then b := b || (b -> 'data'); end if;
  if b ? 'lead' and jsonb_typeof(b -> 'lead') = 'object' then b := b || (b -> 'lead'); end if;
  insert into cf_live_raw (kind, body) values ('lead', p_body) returning id into v_id;

  with kv as (select lower(regexp_replace(key, '[^A-Za-z0-9]', '', 'g')) k, value #>> '{}' v from jsonb_each(b))
  select
    right(regexp_replace(coalesce((select v from kv where k in ('mobile','phone','phonenumber','mobilenumber','contactnumber','customernumber','leadnumber') and v ~ '\d{10}' limit 1), ''), '\D', '', 'g'), 10),
    (select v from kv where k in ('createddate','createdon','createdat','created','date','timestamp') and v <> '' limit 1),
    (select v from kv where k in ('uniqueid','leadid','id') and v <> '' limit 1),
    (select v from kv where k in ('clientname','name','leadname','customername','petparentname') limit 1),
    (select v from kv where k in ('purposeofcalling','purpose','service','requirement','enquiry') limit 1),
    (select string_agg(v, ' / ') from kv where k in ('callstatus','substatus','status','leadstatus','appointmentbooked') and v <> ''),
    (select v from kv where k in ('unit','branch','clinic','location') limit 1)
  into v_phone, v_t, v_lid, v_name, v_purpose, v_status, v_unit;
  begin
    if v_t ~ '^\d{10,13}$' then
      v_at := to_timestamp(case when length(v_t) > 10 then v_t::bigint / 1000 else v_t::bigint end) at time zone 'Asia/Kolkata';
    elsif v_t ~ '([+-]\d\d:?\d\d|Z)$' then v_at := v_t::timestamptz at time zone 'Asia/Kolkata';
    elsif v_t is not null then v_at := v_t::timestamp;
    end if;
  exception when others then v_at := null;
  end;
  if length(v_phone) = 10 then
    insert into leads (lead_key, created_at, phone, name, purpose, status, unit, raw)
    values ('live:' || coalesce(v_lid, md5(b::text)), coalesce(v_at, (now() at time zone 'Asia/Kolkata')::timestamp), v_phone,
            left(v_name, 120), left(v_purpose, 200), left(v_status, 200), left(v_unit, 60), b)
    on conflict (lead_key) do update set status = excluded.status, purpose = coalesce(excluded.purpose, leads.purpose),
           unit = coalesce(excluded.unit, leads.unit), raw = excluded.raw, loaded_at = now();
    update cf_live_raw set saved = true where id = v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'saved', true);
  end if;
  update cf_live_raw set note = 'kept raw: no phone found' where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'saved', false);
end $$;
revoke all on function public.cf_lead_webhook(text, jsonb) from public;
grant execute on function public.cf_lead_webhook(text, jsonb) to anon;

create or replace function calldesk.cf_live_lead_dedupe() returns trigger language plpgsql as $$
begin
  if new.lead_key not like 'live:%' then
    delete from calldesk.leads where lead_key like 'live:%' and phone = new.phone
       and created_at between new.created_at - interval '5 minutes' and new.created_at + interval '5 minutes';
  end if;
  return null;
end $$;
drop trigger if exists leads_cf_live_dedupe on calldesk.leads;
create trigger leads_cf_live_dedupe after insert on calldesk.leads
  for each row execute function calldesk.cf_live_lead_dedupe();
create index if not exists leads_phone_created on calldesk.leads (phone, created_at);
notify pgrst, 'reload schema';
