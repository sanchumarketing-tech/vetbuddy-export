-- =====================================================================
-- Gofrugal pharmacy sales + one combined "all sales" view for the bot.
-- Run ONCE in the Supabase SQL Editor, after 01_schema.sql and 02_users.sql.
-- =====================================================================

CREATE TABLE vetbuddy.pharmacy_sales (
    id            BIGSERIAL PRIMARY KEY,
    sale_date     DATE        NOT NULL,   -- Bill Dt. (sales) / Return Date (returns)
    kind          TEXT        NOT NULL,   -- 'sale' or 'return'
    outlet        TEXT,                   -- Gofrugal outlet, e.g. 'Sanchu Adyar'
    clinic        TEXT,                   -- e.g. 'Adyar'
    bill_no       TEXT,
    item_name     TEXT,
    manufacturer  TEXT,
    hsn_sac       TEXT,
    qty           NUMERIC(12,3),          -- negative for returns
    amount        NUMERIC(14,2),          -- Item Amt BeforeTax; returns: −Sub Total
    tax_amount    NUMERIC(14,2),
    net_amount    NUMERIC(14,2),          -- incl. GST
    doctor        TEXT,
    doctor_code   TEXT,                   -- P00158 …
    salesman      TEXT,
    is_vow        BOOLEAN NOT NULL DEFAULT false,  -- same doctor did a VOW invoice that day at that clinic
    clinic_unit   TEXT,
    vow_unit      TEXT,
    sales_unit    TEXT,
    loaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE vetbuddy.pharmacy_sales DISABLE ROW LEVEL SECURITY;
CREATE INDEX ix_pharm_date      ON vetbuddy.pharmacy_sales (sale_date);
CREATE INDEX ix_pharm_unit_date ON vetbuddy.pharmacy_sales (sales_unit, sale_date);

-- what the bot reads for pharmacy questions (no customer names / phones)
CREATE VIEW vetbuddy.v_pharmacy_bot AS
SELECT sale_date, kind, clinic, outlet, bill_no, item_name, manufacturer, qty,
       amount, tax_amount, net_amount, doctor, is_vow, sales_unit, clinic_unit, vow_unit
FROM vetbuddy.pharmacy_sales;

-- ALL sales = VetBuddy (services + goods) + Gofrugal (pharmacy) – same as the Daily Sales Report
CREATE VIEW vetbuddy.v_all_sales AS
SELECT sale_date, 'VetBuddy'::text AS source, invoice_no AS bill_no, clinic,
       item_name, plan_category, plan_subcategory, species, qty,
       amount, is_vow, sales_unit, doctor
FROM vetbuddy.v_sales_bot
UNION ALL
SELECT sale_date, 'Pharmacy', bill_no, clinic,
       item_name, 'Pharmacy', kind, NULL, qty,
       amount, is_vow, sales_unit, doctor
FROM vetbuddy.pharmacy_sales;

GRANT SELECT, INSERT, DELETE ON vetbuddy.pharmacy_sales TO vb_loader;
GRANT USAGE ON SEQUENCE vetbuddy.pharmacy_sales_id_seq TO vb_loader;
GRANT SELECT ON vetbuddy.v_pharmacy_bot, vetbuddy.v_all_sales TO vb_bot;
