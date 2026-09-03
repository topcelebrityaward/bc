-- Top Celebrities Award (TCA) — countdown + nomination applications migration
-- Run this once in the Supabase SQL editor, after 002_transactions_category.sql

alter table categories add column if not exists voting_ends_at timestamptz;

create table if not exists nomination_applications (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone_number text not null,
  category_id uuid references categories(id) on delete cascade,
  status text not null default 'pending', -- pending | accepted | rejected
  created_at timestamptz default now()
);

create index if not exists idx_nomination_applications_status on nomination_applications(status);
