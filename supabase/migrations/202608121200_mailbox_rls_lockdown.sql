-- Lock down schema-only mailbox tables. Node still uses JSON; no browser client.
-- service_role bypasses RLS, so a future API migration is unchanged.

alter table public.mailbox_connections enable row level security;
alter table public.mailbox_tokens enable row level security;
alter table public.mailbox_sync_state enable row level security;
alter table public.email_messages_cache enable row level security;
alter table public.email_attachments enable row level security;

revoke all on public.mailbox_connections from anon, authenticated;
revoke all on public.mailbox_tokens from anon, authenticated;
revoke all on public.mailbox_sync_state from anon, authenticated;
revoke all on public.email_messages_cache from anon, authenticated;
revoke all on public.email_attachments from anon, authenticated;
