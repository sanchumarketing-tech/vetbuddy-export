-- live definition of public.cd_bills(p_phone text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_bills(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  -- read straight from VetBuddy data: vetbuddy.sales line items + one summary line for bills before 20 Dec 2025
  return coalesce((select jsonb_agg(x order by x.sale_date desc, x.invoice_no) from (
    (select s.sale_date, s.invoice_no, s.sales_unit unit, s.patient_name pet, s.item_name item, s.plan_category,
            s.plan_subcategory, s.doctor, round(s.amount) amount
       from vetbuddy.sales s
      where calldesk.norm_phone(s.client_phone) = p_phone and s.sale_date >= calldesk.today() - 400
      order by s.sale_date desc, s.invoice_no limit 40)
    union all
    select o.last_date, 'before-dec-2025', o.last_unit, o.last_pet,
           'Before 20 Dec 2025: ' || o.visit_days || ' visit days since ' || to_char(o.first_date, 'Mon YYYY') ||
           coalesce(', last: ' || nullif(o.last_services, ''), ''), 'History', null, null, o.spend
      from vetbuddy.sales_old_summary o where o.phone = p_phone) x), '[]');
end $function$
;
