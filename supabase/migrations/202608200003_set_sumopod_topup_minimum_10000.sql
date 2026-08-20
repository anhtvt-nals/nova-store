alter table public.payment_invoices
  drop constraint if exists payment_invoices_amount_idr_check;

alter table public.payment_invoices
  add constraint payment_invoices_amount_idr_check
    check (amount_idr >= 10000) not valid;

-- NOT VALID preserves historical sandbox invoices below 10,000 IDR while
-- PostgreSQL still enforces this constraint for every newly inserted/updated
-- payment invoice.
