-- Kenyan Excellence Awards — nomination application fee migration
-- Run this once in the Supabase SQL editor, after 004_delete_categories_nominees.sql

alter table nomination_applications add column if not exists amount numeric default 200;
alter table nomination_applications add column if not exists payment_status text default 'pending'; -- pending | success | failed
alter table nomination_applications add column if not exists fxs_reference text;

create index if not exists idx_nomination_applications_payment on nomination_applications(payment_status, fxs_reference);
