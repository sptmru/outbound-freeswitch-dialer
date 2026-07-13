alter table users
  add column if not exists is_active boolean not null default true;

create index if not exists users_is_active_idx
  on users(is_active, created_at desc);

create index if not exists calls_history_filter_idx
  on calls(created_at desc, campaign_id, agent_id, outcome);

create table if not exists media_access_tickets (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  resource_type text not null check (resource_type in ('call_recording', 'voicemail_recording')),
  resource_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists media_access_tickets_expiry_idx
  on media_access_tickets(expires_at);

create table if not exists suppression_events (
  id uuid primary key default gen_random_uuid(),
  suppression_entry_id uuid references suppression_entries(id) on delete set null,
  actor_user_id uuid references users(id) on delete set null,
  event_type text not null check (
    event_type in ('created', 'updated', 'removed', 'imported', 'blocked_manual_dial')
  ),
  phone_number text not null,
  normalized_phone_number text not null,
  reason text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists suppression_events_created_at_idx
  on suppression_events(created_at desc);

create index if not exists suppression_events_number_idx
  on suppression_events(normalized_phone_number, created_at desc);
