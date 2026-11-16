-- =====================================================================
-- 20  Old VetBuddy bills (16 Nov 2026): one summary row per phone number
--   Source: Sanchu Reports/Vetbuddy Master Data.xlsx on SharePoint (30 Jul 2019 - 19 Dec 2025, 1,047,650 bill lines).
--   Loaded once with history_load.py, summarised per phone, and the full lines removed again: the Free plan's
--   500 MB limit put the project in read-only mode with them. The full detail stays in the SharePoint file.
--   54,174 phone numbers, about 8 MB. Used by the Call Desk: Churned (1 yr+) and the "Before 20 Dec 2025" summary line.
-- =====================================================================
create table if not exists vetbuddy.sales_old_summary (
  phone text primary key, client_name text, first_date date, last_date date, last_unit text, last_pet text,
  last_services text, pets smallint, visit_days int, spend int);
-- built from a per-pet-per-day table (since dropped):
--   select phone, left((array_agg(client_name order by sale_date desc))[1], 60), min(sale_date), max(sale_date),
--          (array_agg(unit order by sale_date desc))[1], left((array_agg(pet_name order by sale_date desc))[1], 40),
--          left((array_agg(array_to_string(subcategories, ', ') order by sale_date desc))[1], 60),
--          count(distinct pet_id), count(distinct sale_date), round(sum(amount))
--     from <per pet per visit day> where phone ~ '^[6-9]\d{9}$' group by phone;
grant select on vetbuddy.sales_old_summary to vb_loader;
