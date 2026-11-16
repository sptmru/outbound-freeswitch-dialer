-- E02 is additive and feature-off. No bootstrap or reconciliation marker changes.
create table inbound_connection_attempts (
  offer_id uuid primary key,
  call_id uuid not null references calls(id) on delete restrict,
  agent_id uuid not null references agents(id),
  attempt integer not null check(attempt between 1 and 3),
  participant_id uuid not null,
  operation_id uuid not null unique,
  bridge_operation_id uuid not null unique,
  guard_operation_id uuid not null unique,
  deadline_at timestamptz not null,
  settled_at timestamptz,
  outcome text check(outcome in ('connected','requeued','fallback','ended')),
  retry_at timestamptz,
  unique(call_id,attempt),
  foreign key(offer_id,call_id,agent_id) references call_offers(id,call_id,agent_id),
  foreign key(participant_id,call_id,agent_id) references call_participants(id,call_id,agent_id),
  foreign key(operation_id,call_id) references call_operations(id,call_id),
  foreign key(bridge_operation_id,call_id) references call_operations(id,call_id),
  foreign key(guard_operation_id,call_id) references call_operations(id,call_id),
  check((settled_at is null) = (outcome is null)),
  check((outcome is not distinct from 'requeued') = (retry_at is not null))
);
create unique index inbound_connection_one_open_idx on inbound_connection_attempts(call_id) where settled_at is null;
create table call_offer_accept_mutations (
  actor_user_id uuid not null references users(id),
  idempotency_key uuid not null,
  offer_id uuid not null references inbound_connection_attempts(offer_id) on delete restrict,
  request_fingerprint text not null check(request_fingerprint ~ '^[0-9a-f]{64}$'),
  primary key(actor_user_id,idempotency_key)
);
create function preserve_inbound_connection() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.settled_at is null or exists(select 1 from calls where id=old.call_id and ended_at is null)
      or exists(select 1 from call_operations where call_id=old.call_id and resolved_at is null) then
      raise exception 'Live or uncertain inbound connection must be retained' using errcode='23514';
    end if;
    return old;
  end if;
  if (to_jsonb(new)-array['settled_at','outcome','retry_at']) is distinct from
    (to_jsonb(old)-array['settled_at','outcome','retry_at']) or
    (old.settled_at is not null and new is distinct from old) then
    raise exception 'Inbound connection identity and settlement are immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger inbound_connection_guard before update or delete on inbound_connection_attempts
  for each row execute function preserve_inbound_connection();
create function preserve_inbound_accept_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' or exists(select 1 from inbound_connection_attempts x join calls c on c.id=x.call_id
    where x.offer_id=old.offer_id and (c.ended_at is null or
      exists(select 1 from call_operations o where o.call_id=c.id and o.resolved_at is null))) then
    raise exception 'Inbound acceptance replay identity is immutable until drained retention' using errcode='23514';
  end if;
  return old;
end $$;
create trigger call_offer_accept_mutation_guard before update or delete on call_offer_accept_mutations
  for each row execute function preserve_inbound_accept_mutation();
