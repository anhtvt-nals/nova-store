-- USD remains the canonical product/order currency. IDR is a locale-specific display conversion.
insert into public.app_settings (key, value)
values ('usd_to_idr_rate', '16000'::jsonb)
on conflict (key) do nothing;

-- Apply the requested rebrand without changing an administrator-customized name.
update public.app_settings
set value = '"Nodenesia"'::jsonb,
    updated_at = timezone('utc', now())
where key = 'site_name'
  and value = '"Proxy Node"'::jsonb;
