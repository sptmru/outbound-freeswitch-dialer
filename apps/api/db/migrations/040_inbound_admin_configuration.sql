-- F01: additive administrative lifecycle and durable HTTP replay/audit.
-- Saved versions and executing route snapshots are never rewritten or deleted.
alter table inbound_flows add column enabled boolean not null default true;
alter table inbound_flows add column deleted_at timestamptz;

create table inbound_configuration_mutations (
  actor_user_id uuid not null references users(id),
  idempotency_key uuid not null,
  fingerprint text not null,
  method text not null check (method in ('POST','PATCH','DELETE')),
  resource text not null check (resource in ('numbers','queues','flows')),
  resource_id uuid not null,
  revision text,
  request_id text not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_user_id,idempotency_key)
);
