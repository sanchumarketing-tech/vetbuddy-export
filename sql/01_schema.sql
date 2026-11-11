-- =====================================================================
-- VetBuddy sales database for Supabase (Postgres).
-- Run ONCE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- Everything lives in its own schema "vetbuddy". Supabase only publishes the
-- "public" schema through its web API, so this data is NOT reachable with
-- the project's public API keys – only through the two database logins below.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS vetbuddy;

-- ---------- 1. Main table: one row per invoice line (same as the master)
CREATE TABLE vetbuddy.sales (
    id                     BIGSERIAL PRIMARY KEY,
    sale_datetime          TIMESTAMP     NOT NULL,  -- B  Date (date + time, India time)
    sale_date              DATE          NOT NULL,  -- date only (what AX shows in the master)
    sr_no                  INTEGER,                 -- A  Sr No.
    client_id              TEXT,                    -- C  Client ID            (personal data)
    client_name            TEXT,                    -- D  Client               (personal data)
    client_phone           TEXT,                    -- E  Primary Phone        (personal data)
    client_email           TEXT,                    -- F  Email ID             (personal data)
    client_gst             TEXT,                    -- G  Client GST Reg No    (personal data)
    invoice_no             TEXT,                    -- H  Invoice #
    gstn                   TEXT,                    -- I  GSTN #
    item_name              TEXT,                    -- J  Services and Goods
    manufacturer           TEXT,                    -- K
    lot_no                 TEXT,                    -- L  Lot#
    expiry                 TEXT,                    -- M  Expiry
    clinic_cost            NUMERIC(14,2),           -- N  Clinic Cost
    unit_price             NUMERIC(14,2),           -- O  MRP / Service Fee
    qty                    NUMERIC(12,3),           -- P  Qty
    gross_sales            NUMERIC(14,2),           -- Q  Total Sales
    discount_name          TEXT,                    -- R
    discount_type          TEXT,                    -- S
    discount_amount        NUMERIC(14,2),           -- T  Discount
    net_sales              NUMERIC(14,2),           -- U  Net Sales (after discount, before tax)
    gst_rate               NUMERIC(7,4),            -- V  GST(in%)  e.g. 0.18
    tax_amount             NUMERIC(14,2),           -- W  Tax
    final_sales            NUMERIC(14,2),           -- X  Final Sales (incl. tax)
    return_qty             NUMERIC(12,3),           -- Y
    return_gross           NUMERIC(14,2),           -- Z  Total Return
    return_discount        NUMERIC(14,2),           -- AA
    return_net             NUMERIC(14,2),           -- AB Net Return
    return_tax             NUMERIC(14,2),           -- AC
    return_total           NUMERIC(14,2),           -- AD Return Total
    sales_person           TEXT,                    -- AE
    doctor                 TEXT,                    -- AF
    goods_or_service       TEXT,                    -- AG Goods / Services
    hsn_sac                TEXT,                    -- AH
    sku                    TEXT,                    -- AI
    brand                  TEXT,                    -- AJ
    size                   TEXT,                    -- AK
    shade                  TEXT,                    -- AL
    sales_type             TEXT,                    -- AM Sales Type (Saloon, Services, Boarding, Pet Taxi…)
    plan_category          TEXT,                    -- AN Plan Category (Treatment, Laboratory, Vaccination…)
    plan_subcategory       TEXT,                    -- AO Plan SubCategory (Surgery, Procedure, Consultation…)
    patient_name           TEXT,                    -- AP Patient              (personal data)
    species                TEXT,                    -- AQ
    breed                  TEXT,                    -- AR
    patient_dob_text       TEXT,                    -- AS DOB (text from VetBuddy)
    patient_gender         TEXT,                    -- AT
    patient_weight_kg      NUMERIC(8,2),            -- AU Weight
    performed_clinic       TEXT,                    -- AV Performed/Carted Clinic (full name)
    billed_clinic          TEXT,                    -- AW Billed Clinic (full name)
    performed_clinic_short TEXT,                    -- e.g. 'Adyar'    (derived)
    billed_clinic_short    TEXT,                    -- e.g. 'Velachery' (derived)
    -- Vet on Wheels split (vow.py – same rule as the master's column AY "VOW Unit")
    is_vow                 BOOLEAN NOT NULL DEFAULT false, -- any line of the invoice is a VOW item
    clinic_unit            TEXT,                    -- ADYAR, ANNA NAGAR, … (from Billed Clinic)
    vow_unit               TEXT,                    -- CH / CBE / MADURAI / TRICHY VET ON WHEELS
    sales_unit             TEXT,                    -- vow_unit for VOW invoices, else clinic_unit
    amount                 NUMERIC(14,2),           -- Net Sales − Net Return (= "sales" in reports)
    loaded_at              TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Supabase may switch on row-level security for new tables automatically. It protects
-- the web API, which does not publish this schema; the two logins (02_users.sql) control
-- access instead. With it on, the daily load fails ("COPY FROM not supported…").
ALTER TABLE vetbuddy.sales DISABLE ROW LEVEL SECURITY;

CREATE INDEX ix_sales_date          ON vetbuddy.sales (sale_date);
CREATE INDEX ix_sales_clinic_date   ON vetbuddy.sales (billed_clinic_short, sale_date);
CREATE INDEX ix_sales_subcat_date   ON vetbuddy.sales (plan_subcategory, sale_date);
CREATE INDEX ix_sales_unit_date     ON vetbuddy.sales (sales_unit, sale_date);
CREATE INDEX ix_sales_invoice       ON vetbuddy.sales (invoice_no);

-- ---------- 2. Load log (the bot shows "data as of …" from this)
CREATE TABLE vetbuddy.load_log (
    id            SERIAL PRIMARY KEY,
    loaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    month_start   DATE,
    date_from     DATE,
    date_to       DATE,
    rows_deleted  INTEGER,
    rows_inserted INTEGER,
    kind          TEXT NOT NULL            -- 'daily' or 'backfill'
);
ALTER TABLE vetbuddy.load_log DISABLE ROW LEVEL SECURITY;

-- ---------- 3. What the bot may read: NO phone, email, GST, client ID,
--               client or patient names (pilot).
CREATE VIEW vetbuddy.v_sales_bot AS
SELECT
    sale_date, sale_datetime, invoice_no,
    item_name, goods_or_service, sales_type, plan_category, plan_subcategory,
    qty, unit_price, gross_sales, discount_name, discount_type, discount_amount,
    net_sales, gst_rate, tax_amount, final_sales,
    return_qty, return_net, return_total,
    amount,                          -- Net Sales − Net Return  (= "sales")
    is_vow, sales_unit, clinic_unit, vow_unit,
    sales_person, doctor,
    species, breed, patient_gender, patient_weight_kg,
    performed_clinic_short AS performed_clinic,
    billed_clinic_short    AS clinic,
    clinic_cost
FROM vetbuddy.sales;

CREATE VIEW vetbuddy.v_data_freshness AS
SELECT loaded_at, date_from, date_to FROM vetbuddy.load_log ORDER BY id DESC LIMIT 1;
