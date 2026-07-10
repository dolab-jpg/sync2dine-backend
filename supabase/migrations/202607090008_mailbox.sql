-- Mailbox integration tables (OAuth IMAP/SMTP cache)
-- Dev uses server/data/mailbox-data.json until server code reads Supabase

create table if not exists mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  user_id text not null,
  provider text not null check (provider in ('google', 'microsoft', 'yahoo', 'nylas')),
  email_address text not null,
  display_name text,
  status text not null default 'connected',
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text
);

create table if not exists mailbox_tokens (
  connection_id uuid primary key references mailbox_connections(id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text not null,
  expires_at timestamptz not null,
  scope text,
  updated_at timestamptz not null default now()
);

create table if not exists mailbox_sync_state (
  connection_id uuid primary key references mailbox_connections(id) on delete cascade,
  folder text not null default 'INBOX',
  last_uid bigint not null default 0,
  uid_validity bigint,
  last_synced_at timestamptz,
  last_error text,
  poll_interval_sec int not null default 180
);

create table if not exists email_messages_cache (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references mailbox_connections(id) on delete cascade,
  uid bigint not null,
  message_id text unique,
  thread_id text,
  subject text,
  from_addr text,
  to_addrs text[],
  snippet text,
  text_body text,
  html_body text,
  received_at timestamptz,
  has_attachments boolean default false,
  synced_at timestamptz default now()
);

create table if not exists email_attachments (
  id uuid primary key default gen_random_uuid(),
  message_cache_id uuid not null references email_messages_cache(id) on delete cascade,
  filename text,
  mime_type text,
  size_bytes bigint,
  storage_path text,
  content_id text
);

create index if not exists idx_email_messages_connection on email_messages_cache(connection_id);
create index if not exists idx_email_messages_thread on email_messages_cache(thread_id);
