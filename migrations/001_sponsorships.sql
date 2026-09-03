-- Top Celebrities Award (TCA) — Sponsor Free Voting Day migration
-- Run this once in the Supabase SQL editor, after schema.sql

create table if not exists sponsorships (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references categories(id) on delete cascade,
  days int not null,
  amount numeric not null,          -- days * SPONSOR_DAY_PRICE, whole KES
  phone_number text not null,
  status text not null default 'pending', -- pending | success | failed
  fxs_reference text,               -- FXS Pay's own transaction id
  starts_at timestamptz,            -- set once payment succeeds
  ends_at timestamptz,              -- starts_at + (days * 24h)
  result_desc text,
  raw_callback jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_sponsorships_category on sponsorships(category_id);
create index if not exists idx_sponsorships_window on sponsorships(starts_at, ends_at);

-- Fast lookup for "is this category free right now" — used on every
-- category listing and every vote attempt
create or replace view active_sponsorships as
select *
from sponsorships
where status = 'success'
  and starts_at <= now()
  and ends_at > now();
