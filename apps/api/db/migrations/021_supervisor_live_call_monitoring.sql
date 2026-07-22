create table if not exists admin_supervisor_endpoints (
  user_id uuid primary key references users(id) on delete cascade,
  sip_username text not null unique,
  sip_password_hash text not null,
  sip_password_encrypted text not null,
  display_name text not null,
  registered boolean not null default false,
  last_registered_at timestamptz,
  last_unregistered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists call_supervisor_sessions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  actor_user_id uuid not null references users(id) on delete restrict,
  mode text not null check (mode in ('listen', 'whisper', 'join')),
  state text not null check (state in ('connecting', 'active', 'ended', 'failed')),
  supervisor_leg_uuid uuid not null,
  originate_job_uuid uuid,
  target_agent_leg_uuid uuid not null,
  target_customer_leg_uuid uuid not null,
  started_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists call_supervisor_sessions_actor_active_uidx
  on call_supervisor_sessions(actor_user_id)
  where state in ('connecting', 'active');

create index if not exists call_supervisor_sessions_call_active_idx
  on call_supervisor_sessions(call_id, started_at desc)
  where state in ('connecting', 'active');

create unique index if not exists call_supervisor_sessions_job_uuid_uidx
  on call_supervisor_sessions(originate_job_uuid)
  where originate_job_uuid is not null;

drop trigger if exists notify_call_supervisor_sessions_changed on call_supervisor_sessions;
create trigger notify_call_supervisor_sessions_changed
after insert or update or delete on call_supervisor_sessions
for each row execute function notify_outbound_dialer_change();
