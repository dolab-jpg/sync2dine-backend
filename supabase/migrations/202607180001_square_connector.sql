-- Square POS outbound connector fields on connector_configs

alter table public.connector_configs
  add column if not exists square_location_id text not null default '';

alter table public.connector_configs
  add column if not exists square_merchant_id text not null default '';

alter table public.connector_configs
  add column if not exists oauth_access_token text not null default '';

alter table public.connector_configs
  add column if not exists oauth_refresh_token text not null default '';

alter table public.connector_configs
  add column if not exists oauth_expires_at timestamptz;

alter table public.connector_configs
  add column if not exists default_pickup_name text not null default '';

alter table public.connector_configs
  add column if not exists default_pickup_phone text not null default '';

alter table public.connector_configs
  add column if not exists fulfillment_address_line1 text not null default '';

alter table public.connector_configs
  add column if not exists fulfillment_address_city text not null default '';

alter table public.connector_configs
  add column if not exists fulfillment_address_postcode text not null default '';

alter table public.connector_configs
  add column if not exists fulfillment_address_country text not null default 'GB';

alter table public.connector_configs
  add column if not exists last_test_push_at timestamptz;

alter table public.connector_configs
  add column if not exists last_test_push_ok boolean;
