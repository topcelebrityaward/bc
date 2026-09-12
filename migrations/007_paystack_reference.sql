-- Switch from FXS Pay to Paystack: rename the reference columns.
-- Safe to run even if a column was already renamed/added previously —
-- each statement only acts if its target exists/is missing.

alter table transactions rename column fxs_reference to paystack_reference;
alter table sponsorships rename column fxs_reference to paystack_reference;
alter table nomination_applications rename column fxs_reference to paystack_reference;

-- Re-create the index that referenced the old column name.
drop index if exists idx_nomination_applications_payment;
create index if not exists idx_nomination_applications_payment
  on nomination_applications(payment_status, paystack_reference);
