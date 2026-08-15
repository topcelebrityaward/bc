-- Kenyan Excellence Awards — add category_id to transactions
-- Run this once in the Supabase SQL editor, after 001_sponsorships.sql
-- Lets us check "how many free votes has this phone used in this category
-- today" without joining through nominees every time.

alter table transactions add column if not exists category_id uuid references categories(id);
create index if not exists idx_transactions_free_vote_lookup on transactions(phone_number, category_id, status, amount);
