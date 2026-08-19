insert into public.products(code, name, service_type, description, config)
values ('socks5-us', 'SOCKS5 Datacenter - Unlimited Bandwidth', 'proxy', 'Rotating SOCKS5 proxy nodes in the United States', '{"protocol":"SOCKS5"}')
on conflict (code) do update set name = excluded.name, description = excluded.description;

insert into public.plans(product_id, code, name, description, price, duration_hours, rotation_minutes, highlighted, sort_order, config)
select id, seed.code, seed.name, seed.description, seed.price, seed.duration_hours, 60, seed.highlighted, seed.sort_order, seed.config
from public.products
cross join (values
  ('starter', 'Starter', 'One clean route for short runs and validation.', 9.00, 24, false, 10, '{"nodeCount":1}'::jsonb),
  ('operator', 'Operator', 'A dependable weekly window for production workflows.', 39.00, 168, true, 20, '{"nodeCount":3}'::jsonb),
  ('scale', 'Scale', 'More concurrent nodes for sustained routing workloads.', 119.00, 720, false, 30, '{"nodeCount":10}'::jsonb)
) as seed(code, name, description, price, duration_hours, highlighted, sort_order, config)
where products.code = 'socks5-us'
on conflict (product_id, code) do update set
  name = excluded.name, description = excluded.description, price = excluded.price,
  duration_hours = excluded.duration_hours, highlighted = excluded.highlighted,
  sort_order = excluded.sort_order, config = excluded.config;

insert into public.resources(product_id, code, name, status, region, capabilities, health, secrets)
select id, 'us-seattle-01', 'Seattle Edge 01', 'online',
  '{"city":"Seattle","country":"US","region":"us-west"}',
  '{"protocol":"SOCKS5","rotation":true}', '{"latencyMs":14}',
  '{"host":"replace-with-real-proxy-host","port":1080,"username":"replace-me","password":"replace-me"}'
from public.products where code = 'socks5-us'
on conflict (code) do update set status = excluded.status, health = excluded.health;

insert into public.resources(product_id, code, name, status, region, capabilities, health, secrets)
select id, 'us-new-york-01', 'New York Edge 01', 'online',
  '{"city":"New York","country":"US","region":"us-east"}',
  '{"protocol":"SOCKS5","rotation":true}', '{"latencyMs":11}',
  '{"host":"replace-with-real-proxy-host","port":1080,"username":"replace-me","password":"replace-me"}'
from public.products where code = 'socks5-us'
on conflict (code) do update set status = excluded.status, health = excluded.health;
