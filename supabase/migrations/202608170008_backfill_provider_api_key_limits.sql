-- Older provider API keys predate per-key capacity controls and therefore
-- have NULL max_sandboxes. NULL was historically interpreted as unlimited,
-- which can repeatedly select the oldest key until the upstream provider
-- rejects it. Make the safe UI default durable for existing credentials.
--
-- Administrators may raise an individual key limit later from Admin >
-- Provider API keys, but it must reflect the upstream account/workspace cap.
update public.provider_api_keys
set max_sandboxes = 10
where max_sandboxes is null;
