-- D01: positive readiness is tied to one immutable, server-observed contact.
alter table agent_desk_sessions add column endpoint_pin text;
alter table agent_desk_sessions add column actor_auth_version integer;
alter table agent_desk_sessions add column registration_cleaned_at timestamptz;
alter table agent_desk_sessions add column registration_checked_at timestamptz;
-- Pre-D01 rows have no authenticated controller version. Preserve evidence, never inherit readiness.
update agent_desk_sessions set endpoint_pin=verified_endpoint,ready=false;

-- Keep mutation results free of SIP credentials. Replays cannot extend a lease.
create table agent_desk_mutations (
  agent_id uuid not null references agents(id) on delete restrict,
  idempotency_key uuid not null,
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(agent_id,idempotency_key)
);
create index agent_desk_sessions_cleanup_idx on agent_desk_sessions(revoked_at,id)
  where revoked_at is not null and registration_cleaned_at is null;
