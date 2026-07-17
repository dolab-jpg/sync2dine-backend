-- Extend usage_events for multi-provider metering (ElevenLabs chars, phone seconds)

alter table usage_events
  add column if not exists provider text,
  add column if not exists unit text,
  add column if not exists quantity numeric not null default 0,
  add column if not exists cost_usd numeric not null default 0,
  add column if not exists metadata jsonb not null default '{}';

update usage_events
set
  provider = coalesce(provider, 'openai'),
  unit = coalesce(unit, 'tokens'),
  quantity = coalesce(nullif(quantity, 0), total_tokens)
where provider is null or unit is null;

create index if not exists idx_usage_events_org_provider
  on usage_events (org_id, provider, created_at desc);
