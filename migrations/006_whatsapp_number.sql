-- Top Celebrities Award (TCA) — add WhatsApp contact number to applications
-- Run this once in the Supabase SQL editor, after 005_nomination_application_fee.sql

alter table nomination_applications add column if not exists whatsapp_number text;
