-- =============================================================================
-- 11  Who may read / write the Power BI tables (run after 09 and 10; safe to re-run)
--
--   Personal data (client ID, names, phone, email, address, call log) stays with the
--   database owner only - same rule as 02_users.sql. The bot logins get:
--     v_vetbuddy_pbi_bot   = v_vetbuddy_pbi WITHOUT personal columns
--     the non-personal lookup tables and the calendar
--   vb_loader (the GitHub job) may replace the call log rows.
-- =============================================================================

-- 1. take back the earlier, too-wide rights
REVOKE ALL ON vetbuddy.v_vetbuddy_pbi, vetbuddy.mv_pbi_owner, vetbuddy.mv_pbi_pet, vetbuddy.mv_pbi_pet_day,
              vetbuddy.ref_deceased, vetbuddy.call_log,
              vetbuddy.v_pbi_unique_client_id, vetbuddy.v_pbi_client_table,
              vetbuddy.v_pbi_summary_table, vetbuddy.v_pbi_summary_phone_no
  FROM vb_bot, vb_teams;

-- 2. privacy-safe view for the bots (no client ID / owner / pet ID, names, phone, email, GST, DOB text)
CREATE OR REPLACE VIEW vetbuddy.v_vetbuddy_pbi_bot AS
SELECT sale_date, sale_datetime, invoice_no, item_name, goods_or_service, sales_type,
       plan_category, plan_subcategory, qty, unit_price, gross_sales, discount_name, discount_type,
       discount_amount, net_sales, gst_rate, tax_amount, final_sales, return_qty, return_net, return_total,
       amount, is_vow, sales_unit, clinic_unit, vow_unit, sales_person, doctor,
       species, breed, patient_gender, patient_weight_kg,
       performed_clinic_short AS performed_clinic, billed_clinic_short AS clinic,
       -- Power BI calculated columns
       unit, year, month, category_lookup, age, age_months, pet_category, obses_lookup,
       deceased_pets, pet_count, aged_pets,
       last_visit_date, days_last_visited, last_service_name, spend_on_last_visit_day,
       last_clinic_spend, last_clinic_lab_count, first_visit_date, client_visit_count,
       previous_visit_date, different, pet_category_split,
       first_bathing_visit, last_bathing_visit, no_of_days_still_visit_bathing, bathing_visit_count,
       bathing_status, avg_bathing_day_diff,
       first_bathing_visit_client, last_bathing_visit_client, no_of_days_still_visit_bathing_client,
       saloon_status, last_saloon_visit, no_of_days_still_visit_saloon_client,
       first_haircut_visit, last_haircut_visit, no_of_days_still_visit_haircut, haircut_visit_count,
       avg_haircut_month_diff, haircut_status,
       first_vaccination_visit, last_vaccination_visit, no_of_days_still_visit_vaccination,
       vaccination_visit_count, avg_vaccination_month_diff, vaccination_status, previous_vaccination_date,
       first_consultation_visit, last_consultation_visit, no_of_days_still_visit_consultation,
       consultation_visit_count, avg_consultation_month_diff, consultation_status,
       first_boarding_visit, last_boarding_visit, no_of_days_still_visit_boarding, boarding_visit_count,
       avg_boarding_day_diff, boarding_status, boarding_session_count,
       callback_date_bathing, callback_date_haircut, services_due,
       total_client_revenue, last_10_visit_revenue, total_client_revenue_wo_sur,
       is_night_service, came_back_for_consultation,
       max_call_date, last_30_days_calls, last_30_days_answered, date_count, answered_date_count,
       -- anonymous ids, so the bot can count pets / owners without seeing client numbers
       md5('pet:' || client_id)      AS pet_key,
       md5('owner:' || client_id_no) AS owner_key
FROM vetbuddy.v_vetbuddy_pbi;

GRANT SELECT ON vetbuddy.v_vetbuddy_pbi_bot,
                vetbuddy.ref_unit, vetbuddy.ref_plan_subcategory, vetbuddy.ref_breed_obase,
                vetbuddy.ref_month, vetbuddy.ref_call_status_type, vetbuddy.ref_category,
                vetbuddy.v_pbi_calendar
  TO vb_bot, vb_teams;
GRANT EXECUTE ON FUNCTION vetbuddy.pbi_client_no(text), vetbuddy.pbi_pet_no(text), vetbuddy.pbi_dob(text),
                          vetbuddy.pbi_months(date, date), vetbuddy.pbi_today()
  TO vb_bot, vb_teams;

-- 3. the GitHub job refreshes the call log from SharePoint
GRANT SELECT, INSERT, DELETE ON vetbuddy.call_log TO vb_loader;
