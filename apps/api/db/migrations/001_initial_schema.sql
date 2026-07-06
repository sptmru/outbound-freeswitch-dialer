create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  role text not null check (role in ('agent', 'admin')),
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  sip_username text not null unique,
  sip_password_hash text not null,
  display_name text not null,
  status text not null default 'offline',
  last_registered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft',
  manual_dialing_enabled boolean not null default false,
  call_recording_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  phone_number text not null,
  normalized_phone_number text not null,
  display_name text,
  source_row_json jsonb not null default '{}'::jsonb,
  mapped_fields_json jsonb not null default '{}'::jsonb,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists csv_imports (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  filename text not null,
  status text not null default 'pending',
  field_mapping_json jsonb not null default '{}'::jsonb,
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  failed_rows integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists recordings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  file_path text not null,
  runtime_file_path text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id),
  campaign_id uuid references campaigns(id),
  contact_id uuid references contacts(id),
  destination_number text not null,
  normalized_destination_number text not null,
  caller_id text,
  state text not null default 'created',
  outcome text,
  recording_id uuid references recordings(id),
  manual_dial boolean not null default false,
  call_recording_enabled boolean not null default false,
  call_recording_path text,
  voicemail_signal_status text,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists call_legs (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  type text not null check (type in ('agent', 'customer')),
  freeswitch_uuid text,
  sip_uri text,
  state text not null default 'created',
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete cascade,
  agent_id uuid references agents(id),
  event_type text not null,
  state text,
  reason_code text,
  freeswitch_event_name text,
  api_command_name text,
  agent_leg_uuid text,
  customer_leg_uuid text,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists suppression_entries (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  normalized_phone_number text not null unique,
  reason text,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists system_settings (
  key text primary key,
  value_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists voicemail_detection_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  signal_type text not null,
  confidence numeric,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists contacts_campaign_id_idx on contacts(campaign_id);
create index if not exists contacts_normalized_phone_number_idx on contacts(normalized_phone_number);
create index if not exists calls_agent_id_created_at_idx on calls(agent_id, created_at desc);
create index if not exists calls_campaign_id_created_at_idx on calls(campaign_id, created_at desc);
create index if not exists call_events_call_id_created_at_idx on call_events(call_id, created_at);
