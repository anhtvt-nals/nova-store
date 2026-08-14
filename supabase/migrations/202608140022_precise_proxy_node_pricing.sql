-- Allow fractional proxy node/day pricing such as USD 0.0125.
alter table public.products alter column base_price type numeric(18,4);
alter table public.orders alter column amount type numeric(18,4);
alter table public.orders alter column unit_price type numeric(18,4);
