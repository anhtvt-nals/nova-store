-- Live QRIS charges the gateway fee to the customer in addition to the
-- invoice amount. Keep pending invoices aligned with the current server-side
-- USD/IDR credit conversion before a verified webhook can complete them.

with conversion as (
  select
    max(value::numeric) filter (where key = 'credits_per_usd') as credits_per_usd,
    max(value::numeric) filter (where key = 'usd_to_idr_rate') as usd_to_idr_rate
  from public.app_settings
  where key in ('credits_per_usd', 'usd_to_idr_rate')
)
update public.payment_invoices invoice
set
  net_amount_idr = invoice.amount_idr,
  credit_amount = round((invoice.amount_idr / conversion.usd_to_idr_rate) * conversion.credits_per_usd, 2),
  updated_at = now()
from conversion
where invoice.provider = 'sumopod'
  and invoice.status = 'pending'
  and conversion.credits_per_usd > 0
  and conversion.usd_to_idr_rate > 0;
