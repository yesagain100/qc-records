-- ============================================================================
-- YesAgain QC — stored list columns for the PHONE table (mobile_audits).
--
-- OPTIONAL, and safe to run at any time: the portal works without it. Run it once
-- in the Supabase SQL editor when the phone table has grown (a few thousand tests).
--
-- Why: the portal's iPhones list shows a few fields that live only inside each
-- row's `snapshot` JSON (model, carrier lock, why it was saved, which Probe …).
-- Without these columns the database has to open every row's snapshot (~16 KB,
-- compressed) to read them — the same cost that slowed the MacBook list until
-- `audits` got its own s_<field> columns on 5 Oct 2026. A stored generated column
-- is computed once, when the row is written, and read like any other column.
--
-- The portal notices by itself: it asks for these columns once per visit and uses
-- them when they are all there, otherwise it reads the snapshot as before. The
-- names and the list must match mobile.js (SNAP_TEXT + SNAP_JSON) — the portal
-- treats a partial set as "not there", so nothing breaks if a field is added to
-- the page before it is added here.
--
-- Additive only: no existing column, row, policy or function is changed.
-- ============================================================================

alter table public.mobile_audits
  add column if not exists s_model               text  generated always as (snapshot->>'model')               stored,
  add column if not exists s_model_number        text  generated always as (snapshot->>'model_number')        stored,
  add column if not exists s_region              text  generated always as (snapshot->>'region')              stored,
  add column if not exists s_technician_username text  generated always as (snapshot->>'technician_username') stored,
  add column if not exists s_department          text  generated always as (snapshot->>'department')          stored,
  add column if not exists s_warehouse           text  generated always as (snapshot->>'warehouse')           stored,
  add column if not exists s_tested_local        text  generated always as (snapshot->>'tested_local')        stored,
  add column if not exists s_timezone            text  generated always as (snapshot->>'timezone')            stored,
  add column if not exists s_app_build           text  generated always as (snapshot->>'app_build')           stored,
  add column if not exists s_probe_version       text  generated always as (snapshot->>'probe_version')       stored,
  add column if not exists s_save_reason         text  generated always as (snapshot->>'save_reason')         stored,
  add column if not exists s_carrier_lock        text  generated always as (snapshot->>'carrier_lock')        stored,
  add column if not exists s_sku                 text  generated always as (snapshot->>'sku')                 stored,
  add column if not exists s_product_sku         text  generated always as (snapshot->>'product_sku')         stored,
  add column if not exists s_bench_port          text  generated always as (snapshot->>'bench_port')          stored,
  add column if not exists s_blockers            jsonb generated always as (snapshot->'blockers')             stored,
  add column if not exists s_warnings            jsonb generated always as (snapshot->'warnings')             stored,
  add column if not exists s_parts_service       jsonb generated always as (snapshot->'parts_service')        stored;

-- PostgREST caches the table's shape: tell it the columns exist.
notify pgrst, 'reload schema';

-- Check (should list 18 rows):
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'mobile_audits' and column_name like 's\_%' order by 1;
