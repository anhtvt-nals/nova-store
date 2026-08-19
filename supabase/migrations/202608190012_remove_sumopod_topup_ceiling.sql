-- The checkout amount has no Nodenesia business ceiling. SumoPod remains the
-- authority for provider-side amount limits; numeric(18,0) is retained as a
-- technical storage bound.

alter table public.payment_invoices
  drop constraint if exists payment_invoices_amount_idr_check;

alter table public.payment_invoices
  add constraint payment_invoices_amount_idr_check
    check (amount_idr >= 10000);
