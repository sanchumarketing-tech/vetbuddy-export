-- =============================================================================
-- 09  Power BI "Vetbuddy" calculated columns, rebuilt on our Supabase data
--
-- Source of the formulas: Sharpshooting_Data.pbix, table Vetbuddy (79 DAX columns).
-- Source of the data:      vetbuddy.sales (the daily VetBuddy load).
--
-- What you get
--   vetbuddy.v_vetbuddy_pbi   one row per sales line = vetbuddy.sales + every
--                             Power BI calculated column (same names, snake_case)
--
-- How it is built
--   ref_*  tables            the Power BI lookup tables (Unit, Plan SubCategory
--                            Lookup, Breed_Obase are filled from the .pbix;
--                            Deceased Data and Call Log are empty - fill them later)
--   mv_pbi_owner / mv_pbi_pet / mv_pbi_pet_day
--                            pre-computed per owner / per pet / per pet-day
--                            (refreshed automatically after every daily load)
--   v_vetbuddy_pbi           joins it all and adds the TODAY()-based columns live
--
-- DAX -> SQL notes
--   * DAX text comparison is case-insensitive, so every comparison uses lower().
--   * "Client ID" in VetBuddy is "<owner no> (<pet no>)": DAX groups by it = per pet.
--     Client_ID_No = owner, Pet_ID_No = pet.
--   * TODAY() = today's date in India.
--   * An unreadable DOB ("---") = 01-01-1700, as in Power Query -> Pet Category 'Error Date'.
-- Run once in the Supabase SQL editor. Safe to run again.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Reference tables (Power BI lookup tables)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vetbuddy.ref_unit (              -- Power BI table "Unit"
    billed_clinic   text PRIMARY KEY,                       -- Clinic (Billed Clinic)
    clinic_location text NOT NULL,                          -- Clinic Location
    sort_no         int
);
CREATE TABLE IF NOT EXISTS vetbuddy.ref_plan_subcategory (  -- "Plan SubCategory Lookup"
    plan_subcategory text PRIMARY KEY,
    category         text                                   -- 'clinical' or '-'
);
CREATE TABLE IF NOT EXISTS vetbuddy.ref_breed_obase (       -- "Breed_Obase"
    breed        text PRIMARY KEY,
    obase_weight numeric
);
CREATE TABLE IF NOT EXISTS vetbuddy.ref_deceased (          -- "Deceased Data" (Deceased Pets Data.xlsx) - fill later
    patient_id    text PRIMARY KEY,                         -- Patient ID (= Pet_ID_No)
    patient       text,
    first_active  date,
    last_active   date,
    client_name   text,
    address       text,
    city          text,
    state         text,
    zip           text,
    birth_date    text,
    deceased_date text,
    species       text,
    breed         text,
    sex           text,
    status        text,
    count         int NOT NULL DEFAULT 1                    -- DAX column Count = 1
);
CREATE TABLE IF NOT EXISTS vetbuddy.call_log (              -- "Call Log" (Backend Call Log Report.xlsx) - fill later
    id               text PRIMARY KEY,
    call_date        timestamp,
    call_type        text,
    customer_name    text,
    customer_number  bigint,
    agent_name       text,
    agent_number     bigint,
    did_number       bigint,
    total_time       int,
    start_time       timestamp,
    end_time         timestamp,
    call_status      text,
    notes            text,
    dtmf             text,
    recording        text,
    credits_utilized text,
    date             date,
    -- DAX: Phone No = RIGHT('Call Log'[Customer Number], 10) * 1
    phone_no         bigint GENERATED ALWAYS AS (nullif(right(customer_number::text, 10), '')::bigint) STORED
);
CREATE INDEX IF NOT EXISTS ix_call_log_phone ON vetbuddy.call_log (phone_no, date);

-- lookup rows copied from the .pbix (DATATABLE tables)
INSERT INTO vetbuddy.ref_unit (billed_clinic, clinic_location, sort_no) VALUES
  ('Sanchu Animal Hospital, Anna Nagar (Division of Cavinkare)', 'Anna Nagar', 3),
  ('Sanchu Animal Hospital - Adyar (Division of Cavinkare)', 'Adyar', 1),
  ('Sanchu Animal Hospital - Palavakkam (Division of Cavinkare)', 'Neelangarai', 2),
  ('Sanchu Animal Hospital - Velachery (Division of Cavinkare)', 'Velachery', 4),
  ('Sanchu Animal Hospital - Koramangala (Division of Cavinkare)', 'Koramangala', 5),
  ('Sanchu Animal Hospital, Anna Nagar (Division of CKR Retail Pvt Ltd)', 'Anna Nagar', 3),
  ('Sanchu Animal Hospital - Coimbatore(Division of CKR Retail)', 'Coimbatore', 6),
  ('Sanchu Animal Hospital - Palavakkam (Division of CKR Retail Pvt Ltd)', 'Neelangarai', 2),
  ('Sanchu Animal Hospital - Nungambakkam (Division of Cavinkare)', 'Nungambakkam', 8),
  ('Sanchu Animal Hospital - Adyar (Division of CKR Retail Pvt Ltd)', 'Adyar', 1),
  ('Sanchu Animal Hospital - Velachery (Division of CKR Retail Pvt Ltd)', 'Velachery', 4),
  ('Sanchu Animal Hospital - Coimbatore(Division of CKR Retail Pvt Ltd)', 'Coimbatore', 6),
  ('Sanchu Animal Hospital - Koramangala (Division of CKR Retail Pvt Ltd)', 'Koramangala', 5),
  ('Sanchu Animal Hospital - Whitefield (Division of CKR Retail Pvt Ltd)', 'Whitefield', 7),
  ('Sanchu Animal Hospital - Vadapalani (Division of Cavinkare)', 'Vadapalani', 10),
  ('Sanchu Animal Hospital - Anna Nagar (Division of CKR Retail Pvt Ltd)', 'Anna Nagar', 3),
  ('Sanchu Animal Hospital - Anna Nagar 2 (Division of CKR Retail Pvt Ltd)', 'Anna Nagar 2', 11),
  ('Sanchu Animal Hospital - Nungambakkam (Division of CKR Retail Pvt Ltd)', 'Nungambakkam', 8),
  ('Sanchu Animal Hospital - Koramangala 2 (Division of CKR Retail Pvt Ltd)', 'Koramangala 2', 12),
  ('Sanchu Animal Hospital - Coimbatore 2 (Division of CKR Retail Pvt Ltd)', 'Coimbatore 2', 13),
  ('Sanchu Animal Hospital - Neelangarai (Division of CKR Retail Pvt Ltd)', 'Neelangarai', 2),
  ('Sanchu Animal Hospital - Madurai (Division of CKR Retail Pvt Ltd)', 'Madurai', 22),
  ('Sanchu Animal Hospital - Valasaravakkam (Division of CKR Retail Pvt Ltd)', 'Valasaravakkam', 23),
  ('Sanchu Animal Hospital - Nungambakkam (Division of Cavinkare Pvt Ltd)', 'Nungambakkam', 8)
ON CONFLICT (billed_clinic) DO UPDATE SET clinic_location = excluded.clinic_location, sort_no = excluded.sort_no;

INSERT INTO vetbuddy.ref_plan_subcategory (plan_subcategory, category) VALUES
  ('OPD', '-'),
  ('Medication', 'clinical'),
  ('Certificate', '-'),
  ('Consultation', 'clinical'),
  ('SCAN', 'clinical'),
  ('Procedure', 'clinical'),
  ('Diagnostics', '-'),
  ('Treatment', '-'),
  ('CLINICAL PATHOLOGY', 'clinical'),
  ('CLINICAL BIOCHEMISTRY', 'clinical'),
  ('HAEMATOLOGY', 'clinical'),
  ('Hygenine', '-'),
  ('Bathing', '-'),
  ('Surgery', '-'),
  ('PET TRANSPORT SERVICES', '-'),
  ('HOLIDAY BOARDING', '-'),
  ('NURSING', '-'),
  ('MOLECULAR TEST', 'clinical'),
  ('Drug And Medical Items 12%', '-'),
  ('Toys, Collars and Other Durables 18%', '-'),
  ('Food 18%', '-'),
  ('Drug And Medical Items 18%', '-'),
  ('Pet Food', '-'),
  ('Vaccine', '-'),
  ('Laboratory', 'clinical'),
  ('Antacids and Anti-emmetics', 'clinical'),
  ('Hematology', 'clinical'),
  ('OFFER', '-'),
  ('Grooming Consultation', '-'),
  ('Haircut', '-'),
  ('Medvet', '-'),
  ('Antibiotic', 'clinical'),
  ('General Physical', '-'),
  ('Balanced Electrolytes & Glucose', '-'),
  ('Grooming', '-'),
  ('Drug And Medical Items 0%', '-'),
  ('MICROBIOLOGY', 'clinical'),
  ('Rescue Scan', 'clinical'),
  ('IP Boarding', '-'),
  ('Home made food', '-'),
  ('vaccination', 'clinical'),
  ('Vitamins and Minerals', 'clinical'),
  ('Other', '-'),
  ('IMMUNOLOGY', 'clinical'),
  ('RAPID TEST', 'clinical'),
  ('Health check up', 'clinical'),
  ('Consent Forms', '-'),
  ('Drug And Medical Items 5%', 'clinical'),
  ('Customary Hair Cut', '-'),
  ('Show Grooming / Styling', '-'),
  ('Toys, Collars and Other Durables 12%', '-'),
  ('Toys, Collars and Other Durables 0%', '-'),
  ('Isoflurane', '-'),
  ('CCU Bed Charge', '-'),
  ('Food 0%', '-'),
  ('Toys, Collars and Other Durables 5%', '-'),
  ('BOARDING', '-'),
  ('IMMUNO CHROMATOGRAPHIC TESTS', 'clinical'),
  ('Rescue Surgery', '-'),
  ('Detangling / Dematting', '-'),
  ('Offers', '-'),
  ('GASTROENTEROLOGY', 'clinical'),
  ('UROLOGY', 'clinical'),
  ('Training Equipment', '-'),
  ('Bayer', '-'),
  ('Transport', '-'),
  ('Homeopathy', 'clinical'),
  ('Nutritional Consultation', 'clinical'),
  ('PROFILES - DISEASE SPECIFIC', 'clinical'),
  ('Office Supplies', '-'),
  ('Routine', '-'),
  ('IMMUNOCHEMISTRY', 'clinical'),
  ('SPA Dog (Long coat)', '-'),
  ('Ztrack', '-'),
  ('Sanchu Puppy Package (upto 4months)', '-'),
  ('Laser', 'clinical'),
  ('NSAID', 'clinical'),
  ('Parasitology', 'clinical'),
  ('Abdominal Radiography', 'clinical'),
  ('Nutraceuticals', 'clinical'),
  ('Cardiac Ultrasound 2 D Echo', 'clinical'),
  ('Antibiotics', 'clinical'),
  ('Chemotherapy Injectable', 'clinical'),
  ('Hepato Biliary Drugs', '-'),
  ('CLIN PATHOLOGY', 'clinical'),
  ('Iams', '-'),
  ('Medications', 'clinical'),
  ('Topical Therapy', 'clinical'),
  ('Parasiticide', 'clinical'),
  ('Molecular Diagnostics', 'clinical'),
  ('Sanchu Premium Package', '-'),
  ('Royal Canin', '-'),
  ('Otoscopy', 'clinical'),
  ('Antihistamines', 'clinical'),
  ('Bandaging', 'clinical'),
  ('Bronchodilator', 'clinical'),
  ('Deworming', '-'),
  ('cages', '-'),
  ('Hills', '-'),
  ('Calibra Pet Food', '-'),
  ('Standard Protocols', '-'),
  ('Diuretic', '-'),
  ('Anti Allergic Tablet', '-')
ON CONFLICT (plan_subcategory) DO UPDATE SET category = excluded.category;

INSERT INTO vetbuddy.ref_breed_obase (breed, obase_weight) VALUES
  ('Pug', 12),
  ('Shih Tzu', 8),
  ('Labrador', 45),
  ('cavapoo', 12),
  ('Golden Retriever', 40),
  ('Siberian Husky', 35),
  ('Beagle', 18),
  ('Daschund', 12),
  ('Chow Chow', 40),
  ('American Pit Bull Terrier', 35),
  ('Labradoodle', 40),
  ('Alaskan Malamute', 50),
  ('Poodle', 35),
  ('Cocker Spanial English', 20),
  ('German Shepherd', 45),
  ('Husky cross', 45),
  ('Lab Retriever', 45),
  ('Toy pomeranian', 5),
  ('Poodle-Toy', 6),
  ('Maltese', 6),
  ('Rottweiler', 70),
  ('Persian', 6),
  ('Rag Doll', 10),
  ('Lhasa Apso', 10),
  ('Jack(Parson) Russel Terrier', 12),
  ('Boxer', 40),
  ('Mongrel', 25),
  ('Lhasapso', 10),
  ('Great Dane', 110),
  ('Bull Mastiff', 80),
  ('German Shephered', 45),
  ('Shih-Poo', 12),
  ('Saint Bernard', 100),
  ('Spitz cross', 20),
  ('Fox Terrier', 15),
  ('Spitz', 20),
  ('West Highland White Terrier', 15),
  ('Tibetan Mastiff', 85),
  ('Mini Poodle', 9),
  ('German Spitz', 18),
  ('Pomeranian', 8),
  ('Tibetan Spaniel', 10),
  ('Mini Pom', 6),
  ('cocker-spaniel cross', 25),
  ('Neapolitan Mastiff', 80),
  ('Rajapalayam', 35),
  ('Terrier', 18),
  ('Yorkshire Terrier', 6),
  ('Cocker Spaniel - American', 20),
  ('Indi', 20),
  ('Bearded Collie', 40),
  ('corgi', 20),
  ('Pit Bull', 32),
  ('Lasa Terrier', 10),
  ('Silky terrier', 7),
  ('_Terrier', 18),
  ('Pom Cross', 10),
  ('Lhadese', 8),
  ('Cross Breed', 50),
  ('Maine Coon Cat', 12),
  ('Bichon Frise', 12),
  ('min pin', 8),
  ('Pomerian cross', 10),
  ('Border Terrier', 15),
  ('Indian Spritz', 20),
  ('Lab Cross', 40),
  ('Pug Cross', 12),
  ('Tibetan Terrier', 12),
  ('German Cross', 50),
  ('Japanese Spitz', 15),
  ('Terrier Cross', 20),
  ('Himalayan', 8),
  ('Indian Cat', 6),
  ('Mongrel Cross', 25),
  ('Himalayan Sheepdog', 45),
  ('Domestic Medium Hair', 12),
  ('Rottweiler cross', 55),
  ('Irish Terrier', 18),
  ('Akita', 70),
  ('Dalmation', 40),
  ('Combai', 50),
  ('Miniature - Yorkshire', 6),
  ('Chihuahua', 8),
  ('Bichon Friese', 12),
  ('Border Collie', 25),
  ('Maltipoo', 10),
  ('Shiba Inu', 15),
  ('Cairn Terrier', 12),
  ('Havanese', 9),
  ('Golden Cross', 45),
  ('Kombei', 50),
  ('Bulli kutta', 50),
  ('Rampur hound', 55),
  ('French Bulldog', 20),
  ('Poodle-Miniature', 9),
  ('American Staffordshire Terrier', 45),
  ('Belgian Malinois', 50),
  ('Pm Cross', 20),
  ('Siamese', 8),
  ('Persian Cross', 8),
  ('Doberman', 50),
  ('Kanni', 35),
  ('American Bulli', 55),
  ('American Bulldog', 60),
  ('Basset Hound', 35),
  ('Fox Terrier - Toy', 8),
  ('Miniture Schnauzer', 12),
  ('Pekingese', 8),
  ('Afghan Hound', 35),
  ('Mastiff', 100),
  ('French Mastiff', 80),
  ('Anatolian Shepherd Dog', 70),
  ('Rajapalayam Cross', 35),
  ('German Pinscher', 22),
  ('Miniature Schnauzer', 12),
  ('British Longhair', 10),
  ('Semi Persian', 8),
  ('Malinois', 55),
  ('Russian Blue', 8),
  ('persian cat', 8),
  ('Cockapo', 18),
  ('Belgian Sheepdog', 40),
  ('Calico', 8),
  ('Bulldog', 35),
  ('Belgian Shepherd', 50),
  ('Doodle', 35),
  ('Welsh Springer Spaniel', 30),
  ('Monkey terrier', 18),
  ('Sheltie', 15),
  ('Malamute', 65),
  ('unknown', 50)
ON CONFLICT (breed) DO UPDATE SET obase_weight = excluded.obase_weight;

-- ---------------------------------------------------------------------------
-- 2. Helpers (DAX text functions)
-- ---------------------------------------------------------------------------
-- Client_ID_No: LEFT([Client ID], SEARCH("(", [Client ID]) - 2)
CREATE OR REPLACE FUNCTION vetbuddy.pbi_client_no(id text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN strpos(id, '(') > 1 THEN left(id, strpos(id, '(') - 2) END
$$;
-- Pet_ID_No: MID between "(" and ")", "" on error
CREATE OR REPLACE FUNCTION vetbuddy.pbi_pet_no(id text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(substring(id from '\(([^)]*)\)'), '')
$$;
-- DOB: VetBuddy text like 'Apr, 01 2012'. Power Query replaces an unreadable DOB ('---')
-- with 01-01-1700 (#"Replaced Errors"), so those pets come out as 'Error Date' - same here.
CREATE OR REPLACE FUNCTION vetbuddy.pbi_dob(t text) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~ '^[A-Za-z]{3}, [0-9]{1,2} [0-9]{4}$' THEN to_date(t, 'Mon, DD YYYY')
              WHEN nullif(trim(t), '') IS NOT NULL THEN date '1700-01-01' END
$$;
-- DATEDIFF(a, b, MONTH): month boundaries crossed
CREATE OR REPLACE FUNCTION vetbuddy.pbi_months(a date, b date) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT ((extract(year from b) - extract(year from a)) * 12 + extract(month from b) - extract(month from a))::int
$$;
-- TODAY() in India
CREATE OR REPLACE FUNCTION vetbuddy.pbi_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

-- ---------------------------------------------------------------------------
-- 3. Pre-computed parts
-- ---------------------------------------------------------------------------
-- (views from files 10 / 11 that sit on top are dropped too: re-run 10 and 11 after this file)
DROP VIEW IF EXISTS vetbuddy.v_vetbuddy_pbi_bot, vetbuddy.v_pbi_client_table, vetbuddy.v_pbi_unique_client_id;
DROP VIEW IF EXISTS vetbuddy.v_vetbuddy_pbi;
DROP MATERIALIZED VIEW IF EXISTS vetbuddy.mv_pbi_pet_day;
DROP MATERIALIZED VIEW IF EXISTS vetbuddy.mv_pbi_pet;
DROP MATERIALIZED VIEW IF EXISTS vetbuddy.mv_pbi_owner;

-- per owner (Client_ID_No)
CREATE MATERIALIZED VIEW vetbuddy.mv_pbi_owner AS
SELECT vetbuddy.pbi_client_no(client_id)                                   AS client_id_no,
       max(sale_date)                                                      AS last_visit_date,            -- Last_Visit_Date
       min(sale_date) FILTER (WHERE lower(plan_subcategory) = 'bathing')   AS first_bathing_visit_client, -- First_Bathing_Visit Client
       max(sale_date) FILTER (WHERE lower(plan_subcategory) = 'bathing')   AS last_bathing_visit_client,  -- Last_Bathing_Visit Client
       max(sale_date) FILTER (WHERE lower(plan_category) IN ('spa and saloon', 'spa and saloon 18%'))
                                                                           AS last_saloon_visit,          -- Last_Saloon_Visit
       CASE WHEN count(*) FILTER (WHERE lower(plan_category) IN ('spa and saloon', 'spa and saloon 18%')) = 0
            THEN 'No Saloon' END                                           AS saloon_status               -- Saloon_Status
FROM vetbuddy.sales
WHERE vetbuddy.pbi_client_no(client_id) IS NOT NULL
GROUP BY 1;
CREATE UNIQUE INDEX ON vetbuddy.mv_pbi_owner (client_id_no);

-- per pet (Client ID)
CREATE MATERIALIZED VIEW vetbuddy.mv_pbi_pet AS
WITH s AS (
  SELECT s.client_id, s.sale_date AS d, s.sale_datetime AS dt, coalesce(s.net_sales, 0) AS net,
         lower(s.plan_subcategory) AS sc, lower(s.plan_category) AS pc, lower(s.item_name) AS item,
         lower(c.category) AS cat, lower(u.clinic_location) AS unit,
         o.last_visit_date AS olv
  FROM vetbuddy.sales s
  LEFT JOIN vetbuddy.ref_plan_subcategory c ON lower(c.plan_subcategory) = lower(s.plan_subcategory)
  LEFT JOIN vetbuddy.ref_unit u            ON u.billed_clinic = s.billed_clinic
  LEFT JOIN vetbuddy.mv_pbi_owner o        ON o.client_id_no = vetbuddy.pbi_client_no(s.client_id)
  WHERE s.client_id IS NOT NULL
), s2 AS (
  SELECT s.*, max(d) FILTER (WHERE cat = 'clinical') OVER (PARTITION BY client_id) AS lcd,   -- LastClinicDate
         rank() OVER (PARTITION BY client_id, (coalesce(sc, '') IN ('surgery', 'rescue surgery')) ORDER BY d DESC) AS rk
  FROM s
), board AS (            -- Boarding Session Count: new session when the gap between boarding dates > 1 day
  SELECT client_id, count(*) FILTER (WHERE prev IS NULL OR d - prev > 1) AS sessions
  FROM (SELECT client_id, d, lag(d) OVER (PARTITION BY client_id ORDER BY d) AS prev
        FROM (SELECT DISTINCT client_id, d FROM s WHERE sc LIKE '%holiday boarding%') x) y
  GROUP BY client_id
)
SELECT s2.client_id,
       vetbuddy.pbi_client_no(s2.client_id)                                 AS client_id_no,
       vetbuddy.pbi_pet_no(s2.client_id)                                    AS pet_id_no,
       min(d)                                                               AS first_visit_date,            -- First_Visit_Date
       count(DISTINCT d)                                                    AS client_visit_count,          -- Client Visit Count
       sum(net)                                                             AS total_client_revenue,        -- Total_Client_Revenue
       sum(net) FILTER (WHERE coalesce(sc, '') NOT IN ('surgery', 'rescue surgery')
                          AND coalesce(unit, '') NOT IN ('koramangala', 'koramangala 2', 'whitefield'))
                                                                            AS total_client_revenue_wo_sur, -- Total_Client_Revenue_WO_Sur
       sum(net) FILTER (WHERE coalesce(sc, '') NOT IN ('surgery', 'rescue surgery') AND rk <= 10)
                                                                            AS last_10_visit_revenue,       -- Last_10_Visit_Revenue (TOPN 10 lines, ties kept)
       -- last visit day (= the owner's last visit date)
       CASE WHEN bool_or(d = olv AND item = 'pet microchip administration') THEN 'Microchip'
            ELSE (array_agg(sc_orig ORDER BY lower(sc_orig)) FILTER (WHERE d = olv AND sc IN ('consultation', 'bathing', 'haircut', 'vaccination', 'holiday boarding')))[1]
       END                                                                  AS last_service_name,           -- Last_Service_Name
       sum(net) FILTER (WHERE d = olv)                                      AS spend_on_last_visit_day,     -- Spend_on_Last_Visit Day
       sum(net) FILTER (WHERE d = lcd AND cat = 'clinical')                 AS last_clinic_spend,           -- Last_Clinic_Spend
       count(*) FILTER (WHERE d = lcd AND cat = 'clinical' AND pc = 'laboratory') AS last_clinic_lab_count, -- Last_Clinic_Lab_Count
       -- bathing
       min(d) FILTER (WHERE sc = 'bathing')                                 AS first_bathing_visit,
       max(d) FILTER (WHERE sc = 'bathing')                                 AS last_bathing_visit,
       nullif(count(*) FILTER (WHERE sc = 'bathing'), 0)                    AS bathing_visit_count,
       -- haircut
       min(d) FILTER (WHERE sc = 'haircut')                                 AS first_haircut_visit,
       max(d) FILTER (WHERE sc = 'haircut')                                 AS last_haircut_visit,
       nullif(count(*) FILTER (WHERE sc = 'haircut'), 0)                    AS haircut_visit_count,
       -- vaccination
       min(d) FILTER (WHERE sc = 'vaccination')                             AS first_vaccination_visit,
       max(d) FILTER (WHERE sc = 'vaccination')                             AS last_vaccination_visit,
       nullif(count(*) FILTER (WHERE sc = 'vaccination'), 0)                AS vaccination_visit_count,
       -- consultation
       min(d) FILTER (WHERE sc = 'consultation')                            AS first_consultation_visit,
       max(d) FILTER (WHERE sc = 'consultation')                            AS last_consultation_visit,
       nullif(count(*) FILTER (WHERE sc = 'consultation'), 0)               AS consultation_visit_count,
       max(dt) FILTER (WHERE sc = 'consultation')                           AS last_consultation_datetime,  -- for Came_Back_For_Consultation
       -- holiday boarding
       min(d) FILTER (WHERE sc = 'holiday boarding')                        AS first_boarding_visit,
       max(d) FILTER (WHERE sc = 'holiday boarding')                        AS last_boarding_visit,
       nullif(count(*) FILTER (WHERE sc = 'holiday boarding'), 0)           AS boarding_visit_count,
       max(b.sessions)                                                      AS boarding_session_count
FROM (SELECT s2.*, ss.plan_subcategory AS sc_orig FROM s2
      CROSS JOIN LATERAL (SELECT CASE s2.sc WHEN 'consultation' THEN 'Consultation' WHEN 'bathing' THEN 'Bathing'
                                            WHEN 'haircut' THEN 'Haircut' WHEN 'vaccination' THEN 'Vaccination'
                                            WHEN 'holiday boarding' THEN 'Holiday Boarding' END AS plan_subcategory) ss) s2
LEFT JOIN board b ON b.client_id = s2.client_id
GROUP BY s2.client_id;
CREATE UNIQUE INDEX ON vetbuddy.mv_pbi_pet (client_id);
CREATE INDEX ON vetbuddy.mv_pbi_pet (client_id_no);

-- per pet per day: Previous Visit Date, Previous Vaccination Date
CREATE MATERIALIZED VIEW vetbuddy.mv_pbi_pet_day AS
SELECT client_id, d AS sale_date,
       lag(d) OVER w                                                        AS prev_visit_date,
       max(CASE WHEN vacc THEN d END) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_vaccination_date
FROM (SELECT client_id, sale_date AS d, bool_or(lower(plan_subcategory) = 'vaccination') AS vacc
      FROM vetbuddy.sales WHERE client_id IS NOT NULL GROUP BY 1, 2) x
WINDOW w AS (PARTITION BY client_id ORDER BY d);
CREATE UNIQUE INDEX ON vetbuddy.mv_pbi_pet_day (client_id, sale_date);

-- ---------------------------------------------------------------------------
-- 4. The view: vetbuddy.sales + all Power BI calculated columns
-- ---------------------------------------------------------------------------
CREATE VIEW vetbuddy.v_vetbuddy_pbi AS
WITH today AS (SELECT vetbuddy.pbi_today() AS t),
max_date AS (SELECT max(sale_date) AS m FROM vetbuddy.sales),
pets AS (   -- Power BI table "Unique Client Id": active pets per owner (pets not in Deceased Data)
  SELECT p.client_id_no, count(DISTINCT p.pet_id_no) FILTER (WHERE d.patient_id IS NULL OR d.count IS DISTINCT FROM 1) AS active_pets_count
  FROM vetbuddy.mv_pbi_pet p LEFT JOIN vetbuddy.ref_deceased d ON d.patient_id = p.pet_id_no
  GROUP BY 1
),
calls AS (  -- Call Log per phone number
  SELECT phone_no,
         max(date)                                                          AS max_call_date,
         count(*) FILTER (WHERE date BETWEEN (SELECT t FROM today) - 30 AND (SELECT t FROM today)) AS last_30_days_calls,
         count(*) FILTER (WHERE date BETWEEN (SELECT t FROM today) - 30 AND (SELECT t FROM today)
                            AND lower(call_status) = 'answered')            AS last_30_days_answered,
         count(DISTINCT date)                                               AS date_count,
         count(DISTINCT date) FILTER (WHERE lower(call_status) = 'answered') AS answered_date_count
  FROM vetbuddy.call_log WHERE phone_no IS NOT NULL GROUP BY 1
),
base AS (
  SELECT s.*,
         s.sale_date                                        AS date_format,
         vetbuddy.pbi_client_no(s.client_id)                AS client_id_no,
         vetbuddy.pbi_pet_no(s.client_id)                   AS pet_id_no,
         vetbuddy.pbi_dob(s.patient_dob_text)               AS dob,
         nullif(right(regexp_replace(coalesce(s.client_phone, ''), '\D', '', 'g'), 10), '')::bigint AS phone_no,
         lower(s.item_name) IN ('review night (night 10pm to till morning 7am)',
                                'night service consultation ( night 10pm till 7am morning )',
                                'night service (10pm to 7am)') AS night
  FROM vetbuddy.sales s
)
SELECT b.*,
       dec.status                                                          AS deceased_pets,             -- Deceased Pets
       pets.active_pets_count                                              AS pet_count,                 -- Pet_Count
       (extract(year from b.sale_date) - extract(year from b.dob))::int    AS age,                       -- Age (DATEDIFF YEAR)
       br.obase_weight                                                     AS obses_lookup,              -- Obses Lookup
       u.clinic_location                                                   AS unit,                      -- Unit
       to_char(b.sale_date, 'YYYY')                                        AS year,                      -- Year
       o.last_visit_date,                                                                                -- Last_Visit_Date
       (SELECT m FROM max_date) - o.last_visit_date                        AS days_last_visited,         -- Days_Last_Visited
       p.last_service_name,
       p.spend_on_last_visit_day,
       pc.category                                                         AS category_lookup,           -- Category Lookup
       p.last_clinic_spend,
       p.last_clinic_lab_count,
       -- bathing
       p.first_bathing_visit, p.last_bathing_visit,
       coalesce(t.t - p.last_bathing_visit, 0)                             AS no_of_days_still_visit_bathing,
       p.bathing_visit_count,
       CASE WHEN p.bathing_visit_count IS NULL THEN 'No Bathing' END       AS bathing_status,
       CASE WHEN p.bathing_visit_count > 1
            THEN round((p.last_bathing_visit - p.first_bathing_visit)::numeric / (p.bathing_visit_count - 1), 4) END
                                                                           AS avg_bathing_day_diff,
       o.first_bathing_visit_client, o.last_bathing_visit_client,
       coalesce(t.t - o.last_bathing_visit_client, 0)                      AS no_of_days_still_visit_bathing_client,
       o.saloon_status,
       -- haircut
       p.first_haircut_visit, p.last_haircut_visit,
       coalesce(t.t - p.last_haircut_visit, 0)                             AS no_of_days_still_visit_haircut,
       p.haircut_visit_count,
       CASE WHEN p.haircut_visit_count > 1
            THEN round(vetbuddy.pbi_months(p.first_haircut_visit, p.last_haircut_visit)::numeric / (p.haircut_visit_count - 1), 4) END
                                                                           AS avg_haircut_month_diff,
       CASE WHEN p.haircut_visit_count IS NULL THEN 'No Haircut' END       AS haircut_status,
       -- vaccination
       p.first_vaccination_visit, p.last_vaccination_visit,
       coalesce(t.t - p.last_vaccination_visit, 0)                         AS no_of_days_still_visit_vaccination,
       p.vaccination_visit_count,
       CASE WHEN p.vaccination_visit_count > 1
            THEN round(vetbuddy.pbi_months(p.first_vaccination_visit, p.last_vaccination_visit)::numeric / (p.vaccination_visit_count - 1), 4) END
                                                                           AS avg_vaccination_month_diff,
       CASE WHEN p.vaccination_visit_count IS NULL THEN 'No Vaccination' END AS vaccination_status,
       -- consultation
       p.first_consultation_visit, p.last_consultation_visit,
       coalesce(t.t - p.last_consultation_visit, 0)                        AS no_of_days_still_visit_consultation,
       p.consultation_visit_count,
       CASE WHEN p.consultation_visit_count > 1
            THEN round(vetbuddy.pbi_months(p.first_consultation_visit, p.last_consultation_visit)::numeric / (p.consultation_visit_count - 1), 4) END
                                                                           AS avg_consultation_month_diff,
       CASE WHEN p.consultation_visit_count IS NULL THEN 'No Consultation' END AS consultation_status,
       -- holiday boarding
       p.first_boarding_visit, p.last_boarding_visit,
       coalesce(t.t - p.last_boarding_visit, 0)                            AS no_of_days_still_visit_boarding,
       p.boarding_visit_count,
       CASE WHEN p.boarding_visit_count > 1
            THEN round((p.last_boarding_visit - p.first_boarding_visit)::numeric / (p.boarding_visit_count - 1), 4) END
                                                                           AS avg_boarding_day_diff,
       CASE WHEN p.boarding_visit_count IS NULL THEN 'No Boarding' END     AS boarding_status,
       p.first_visit_date,
       CASE WHEN lower(b.plan_subcategory) = 'vaccination' THEN pd.prev_vaccination_date END AS previous_vaccination_date,
       CASE WHEN lower(b.plan_subcategory) LIKE '%holiday boarding%' THEN p.boarding_session_count END AS boarding_session_count,
       p.client_visit_count,
       length(regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g')) AS phone_no_length,           -- Phone No Lenth
       p.last_bathing_visit + 30                                           AS callback_date_bathing,
       nullif(concat_ws(', ',
              CASE WHEN t.t - p.last_bathing_visit = 30 THEN 'Bathing' END,
              CASE WHEN t.t - p.last_haircut_visit = 45 THEN 'Haircut' END), '') AS services_due,
       p.last_haircut_visit + 45                                           AS callback_date_haircut,
       to_char(b.sale_date, 'DD-MM-YYYY') || coalesce(b.client_id_no, '')  AS combo_date_client_id,      -- Combo Date & Client ID
       p.total_client_revenue,
       p.last_10_visit_revenue,
       p.total_client_revenue_wo_sur,
       b.night::int                                                        AS is_night_service,
       CASE WHEN b.night AND p.last_consultation_datetime > b.sale_datetime THEN 'Yes' ELSE 'No' END
                                                                           AS came_back_for_consultation,
       to_char(b.sale_date, 'Mon-YY')                                      AS month,
       o.last_saloon_visit,
       coalesce(t.t - o.last_saloon_visit, 0)                              AS no_of_days_still_visit_saloon_client,
       coalesce(pets.active_pets_count >= 5, false)                        AS aged_pets,                 -- Aged Pets (Pet_Count >= 5)
       vetbuddy.pbi_months(b.dob, b.sale_date)                             AS age_months,
       CASE WHEN b.dob IS NULL THEN NULL
            WHEN vetbuddy.pbi_months(b.dob, b.sale_date) > 400 THEN 'Error Date'
            WHEN vetbuddy.pbi_months(b.dob, b.sale_date) <= 6  THEN 'Puppy'
            WHEN vetbuddy.pbi_months(b.dob, b.sale_date) >= 60 THEN 'Aged'
            ELSE 'Adult' END                                               AS pet_category,
       c.max_call_date,
       coalesce(c.last_30_days_calls, 0)                                   AS last_30_days_calls,
       coalesce(c.last_30_days_answered, 0)                                AS last_30_days_answered,
       coalesce(pd.prev_visit_date, b.sale_date)                           AS previous_visit_date,
       b.sale_date - coalesce(pd.prev_visit_date, b.sale_date)             AS different,
       CASE WHEN b.sale_date - coalesce(pd.prev_visit_date, b.sale_date) = 0   THEN 'New Pets'
            WHEN b.sale_date - coalesce(pd.prev_visit_date, b.sale_date) <= 30  THEN 'With in 1 Months'
            WHEN b.sale_date - coalesce(pd.prev_visit_date, b.sale_date) <= 180 THEN 'With in 6 Months'
            WHEN b.sale_date - coalesce(pd.prev_visit_date, b.sale_date) <= 365 THEN 'With in 12 Months'
            WHEN b.sale_date - coalesce(pd.prev_visit_date, b.sale_date) <= 545 THEN 'With in 18 Months'
            ELSE 'More than 18 Months' END                                 AS pet_category_split,
       c.date_count,
       c.answered_date_count
FROM base b
CROSS JOIN today t
LEFT JOIN vetbuddy.mv_pbi_pet p          ON p.client_id = b.client_id
LEFT JOIN vetbuddy.mv_pbi_owner o        ON o.client_id_no = b.client_id_no
LEFT JOIN vetbuddy.mv_pbi_pet_day pd     ON pd.client_id = b.client_id AND pd.sale_date = b.sale_date
LEFT JOIN pets                           ON pets.client_id_no = b.client_id_no
LEFT JOIN vetbuddy.ref_deceased dec      ON dec.patient_id = b.pet_id_no
LEFT JOIN vetbuddy.ref_breed_obase br    ON lower(br.breed) = lower(b.breed)
LEFT JOIN vetbuddy.ref_unit u            ON u.billed_clinic = b.billed_clinic
LEFT JOIN vetbuddy.ref_plan_subcategory pc ON lower(pc.plan_subcategory) = lower(b.plan_subcategory)
LEFT JOIN calls c                        ON c.phone_no = b.phone_no;

-- ---------------------------------------------------------------------------
-- 5. Refresh: after every daily load (row in load_log), and on demand
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vetbuddy.refresh_pbi() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = vetbuddy, public AS $$
BEGIN
  REFRESH MATERIALIZED VIEW vetbuddy.mv_pbi_owner;     -- first: mv_pbi_pet uses it
  REFRESH MATERIALIZED VIEW vetbuddy.mv_pbi_pet;
  REFRESH MATERIALIZED VIEW vetbuddy.mv_pbi_pet_day;
  RETURN 'refreshed ' || now();
END $$;

CREATE OR REPLACE FUNCTION vetbuddy.trg_refresh_pbi() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = vetbuddy, public AS $$
BEGIN
  BEGIN
    PERFORM vetbuddy.refresh_pbi();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Power BI columns not refreshed: %', SQLERRM;   -- never block the daily load
  END;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS refresh_pbi_after_load ON vetbuddy.load_log;
CREATE TRIGGER refresh_pbi_after_load AFTER INSERT ON vetbuddy.load_log
  FOR EACH STATEMENT EXECUTE FUNCTION vetbuddy.trg_refresh_pbi();

-- ---------------------------------------------------------------------------
-- 6. Access (the bot logins read; nobody outside gets in - schema is not exposed)
-- ---------------------------------------------------------------------------
-- Access rights: see 11_pbi_access.sql (personal data stays away from the bot logins).
REVOKE ALL ON FUNCTION vetbuddy.refresh_pbi() FROM PUBLIC;
