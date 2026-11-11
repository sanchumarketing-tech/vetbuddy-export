-- =============================================================================
-- 10  The other Power BI tables (Sharpshooting_Data.pbix), on our Supabase data
--   Typed-in tables -> real tables:  ref_month, ref_call_status_type, ref_category
--   DAX tables      -> views:        v_pbi_calendar, v_pbi_client_table,
--                                    v_pbi_unique_client_id, v_pbi_summary_table,
--                                    v_pbi_summary_phone_no
--   (Unit, Plan SubCategory Lookup, Breed_Obase, Deceased Data, Call Log: file 09)
-- Run after 09. Safe to run again.
-- =============================================================================

-- Month_Table
CREATE TABLE IF NOT EXISTS vetbuddy.ref_month (month text PRIMARY KEY, s_no int NOT NULL);
INSERT INTO vetbuddy.ref_month VALUES ('January',1),('February',2),('March',3),('April',4),('May',5),('June',6),
  ('July',7),('August',8),('September',9),('October',10),('November',11),('December',12)
ON CONFLICT (month) DO UPDATE SET s_no = excluded.s_no;

-- CallStatustype
CREATE TABLE IF NOT EXISTS vetbuddy.ref_call_status_type (name text PRIMARY KEY, sort_no int NOT NULL);
INSERT INTO vetbuddy.ref_call_status_type VALUES ('Same Day',1),('Next Day',2),('Delayed Calls',3),('Not Called',4)
ON CONFLICT (name) DO UPDATE SET sort_no = excluded.sort_no;

-- Category Table
CREATE TABLE IF NOT EXISTS vetbuddy.ref_category (
  category_1 text PRIMARY KEY, category_2 text, return text, s_no int);
INSERT INTO vetbuddy.ref_category VALUES
  ('Consultation','Consultation','Walk-in',1), ('Review','Review','Walk-in',2),
  ('Vaccination','Vaccination','Walk-in',4),   ('Bathing','Saloon','Walk-in',3),
  ('Haircut','Saloon','Walk-in',3),            ('IP boarding','Boarding','Walk-in',5),
  ('Holiday Boarding','Boarding','Walk-in',5), ('Surgery','Surgery','Walk-in',6)
ON CONFLICT (category_1) DO UPDATE SET category_2 = excluded.category_2, return = excluded.return, s_no = excluded.s_no;

-- Calendar = CALENDAR(2018-01-01, 2026-12-31) (extended to the end of next year so it never runs out)
CREATE OR REPLACE VIEW vetbuddy.v_pbi_calendar AS
SELECT d::date                         AS date,
       trim(to_char(d, 'Month'))       AS month,          -- FORMAT(Date,"mmmm")
       to_char(d, 'YYYY')              AS year,
       trim(to_char(d, 'Month'))       AS working_month,
       m.s_no                          AS sort            -- LOOKUPVALUE(Month_Table[S.No], ...)
FROM generate_series(date '2018-01-01',
                     greatest(date '2026-12-31', (date_trunc('year', vetbuddy.pbi_today()) + interval '2 years - 1 day')::date),
                     interval '1 day') d
LEFT JOIN vetbuddy.ref_month m ON m.month = trim(to_char(d, 'Month'));

-- Unique Client Id = DISTINCT(Vetbuddy[Client ID]) + its calculated columns
CREATE OR REPLACE VIEW vetbuddy.v_pbi_unique_client_id AS
WITH u AS (
  SELECT p.client_id, p.client_id_no, p.pet_id_no, d.count AS deceased_pets
  FROM vetbuddy.mv_pbi_pet p
  LEFT JOIN vetbuddy.ref_deceased d ON d.patient_id = p.pet_id_no
), a AS (
  SELECT client_id_no,
         count(DISTINCT pet_id_no)                                               AS pets_count,
         count(DISTINCT pet_id_no) FILTER (WHERE deceased_pets IS DISTINCT FROM 1) AS active_pets_count
  FROM u GROUP BY 1
)
SELECT u.client_id, u.client_id_no, u.pet_id_no, a.pets_count, u.deceased_pets, a.active_pets_count
FROM u JOIN a USING (client_id_no);

-- Client Table = SUMMARIZE(Vetbuddy, Client ID, Client_ID_No, Pet_ID_No, Deceased Pets, Pet_Count, Client, Patient, Breed)
CREATE OR REPLACE VIEW vetbuddy.v_pbi_client_table AS
SELECT DISTINCT s.client_id, vetbuddy.pbi_client_no(s.client_id) AS client_id_no, vetbuddy.pbi_pet_no(s.client_id) AS pet_id_no,
       d.status AS deceased_pets, u.active_pets_count AS pet_count,
       s.client_name AS client, s.patient_name AS patient, s.breed
FROM vetbuddy.sales s
LEFT JOIN vetbuddy.ref_deceased d           ON d.patient_id = vetbuddy.pbi_pet_no(s.client_id)
LEFT JOIN vetbuddy.v_pbi_unique_client_id u ON u.client_id = s.client_id;

-- Summary_Table = SUMMARIZE(Vetbuddy, Client ID, Date_1, "Services" = sub-categories joined, "Daily Spend" = SUM(Net Sales))
CREATE OR REPLACE VIEW vetbuddy.v_pbi_summary_table AS
SELECT client_id, sale_date AS date_1,
       string_agg(DISTINCT plan_subcategory, ', ' ORDER BY plan_subcategory) AS services,
       sum(net_sales)                                                     AS daily_spend
FROM vetbuddy.sales
GROUP BY 1, 2;

-- Summary phone No = SUMMARIZECOLUMNS(Vetbuddy[Phone No], [Answered Date Count], [Date Count])
CREATE OR REPLACE VIEW vetbuddy.v_pbi_summary_phone_no AS
SELECT p.phone_no,
       count(DISTINCT c.date) FILTER (WHERE lower(c.call_status) = 'answered') AS answered_date_count,
       count(DISTINCT c.date)                                                 AS date_count
FROM (SELECT DISTINCT nullif(right(regexp_replace(coalesce(client_phone, ''), '\D', '', 'g'), 10), '')::bigint AS phone_no
      FROM vetbuddy.sales) p
LEFT JOIN vetbuddy.call_log c ON c.phone_no = p.phone_no
WHERE p.phone_no IS NOT NULL
GROUP BY 1;

-- Access rights: see 11_pbi_access.sql (personal data stays away from the bot logins).
