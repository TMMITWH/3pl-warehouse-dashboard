-- ============================================================
-- 3PL Warehouse Operations Dashboard — Supabase schema
-- Run this FIRST, then supabase/seed_generated.sql
-- (or push data with: etl/process_report.py --push)
-- ============================================================

create table if not exists warehouse_transactions (
  id             bigint generated always as identity primary key,
  tx_date        date not null,
  direction      text not null check (direction in ('IMP', 'EXP')),
  staff          text not null,
  prin_code      text not null,
  prin_name      text not null,
  vol_cbm        numeric(12,3) not null default 0,
  is_container   boolean not null default false,
  container_code text default '',
  document_no    text default '',
  created_at     timestamptz default now()
);

-- PRIVATE DATA: only signed-in team members can read.
-- Writes still require the service role key (ETL --push).
alter table warehouse_transactions enable row level security;
create policy "authenticated read" on warehouse_transactions
  for select to authenticated using (true);

create index if not exists idx_wtx_date on warehouse_transactions (tx_date);
create index if not exists idx_wtx_dir  on warehouse_transactions (direction);
create index if not exists idx_wtx_prin on warehouse_transactions (prin_code);
