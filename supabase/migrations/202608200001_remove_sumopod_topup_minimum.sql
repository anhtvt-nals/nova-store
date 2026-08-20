-- Do not impose a Nodenesia business minimum for payment deposits. The
-- gateway remains responsible for any method-specific minimum it enforces.

alter table public.payment_invoices
  drop constraint if exists payment_invoices_amount_idr_check;

alter table public.payment_invoices
  add constraint payment_invoices_amount_idr_check
    check (amount_idr > 0);
