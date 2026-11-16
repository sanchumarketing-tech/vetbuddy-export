-- =====================================================================
-- 20  Old VetBuddy bills, compact (16 Nov 2026)
--   Source: Sanchu Reports/Vetbuddy Master Data.xlsx (30 Jul 2019 - 19 Dec 2025, 1,047,650 bill lines),
--   loaded with history_load.py, then compacted to ONE ROW PER PET PER VISIT DAY (297,185 rows, Rs 34,10,07,740 -
--   same total as the full lines) and the full lines removed from vetbuddy.sales: the Free plan's 500 MB database
--   limit put the project in read-only mode with them. vetbuddy.sales keeps full lines from 20 Dec 2025.
-- =====================================================================
create table if not exists vetbuddy.sales_history (
  pet_id text, phone text, client_name text, pet_name text, species text, breed text, unit text,
  sale_date date not null, invoices int, amount numeric(12,2), categories text[], subcategories text[],
  primary key (pet_id, sale_date, phone));
-- filled per year with:
--   insert into vetbuddy.sales_history
--   select coalesce(substring(client_id from '\(([^)]*)\)'), ''), coalesce(calldesk.norm_phone(client_phone), ''), max(client_name),
--          max(patient_name), max(species), max(breed), max(sales_unit), sale_date, count(distinct invoice_no), sum(amount),
--          array_agg(distinct plan_category) filter (where plan_category is not null),
--          array_agg(distinct plan_subcategory) filter (where plan_subcategory is not null)
--     from vetbuddy.sales where sale_date >= <year start> and sale_date < <year end> group by 1, 2, sale_date;
grant select on vetbuddy.sales_history to vb_loader;
