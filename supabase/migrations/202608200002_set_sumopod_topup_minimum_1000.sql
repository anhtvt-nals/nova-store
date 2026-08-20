alter table public.payment_invoices
  drop constraint if exists payment_invoices_amount_idr_check;

alter table public.payment_invoices
  add constraint payment_invoices_amount_idr_check
    check (amount_idr >= 1000);
