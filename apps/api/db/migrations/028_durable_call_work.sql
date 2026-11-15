-- Feature-off storage contract. No dispatcher, importer, executor or admission
-- writer is enabled here. Legacy capacity operation UUIDs remain valid (026).
create table call_operations (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete restrict,
  idempotency_scope text not null check(length(btrim(idempotency_scope)) between 1 and 200),
  idempotency_key text not null check(length(btrim(idempotency_key)) between 1 and 200),
  request_fingerprint text not null check(request_fingerprint ~ '^[0-9a-f]{64}$'),
  command_kind text not null check(command_kind in
    ('originate','bridge','rebridge','play_audio','hangup','release_agent','forward_external')),
  generation bigint not null check(generation > 0),
  command_uuid uuid not null unique,
  target_uuid uuid,
  request jsonb not null default '{}' check(jsonb_typeof(request)='object' and octet_length(request::text)<=16384),
  state text not null default 'pending' check(state in ('pending','executing','uncertain','succeeded','failed','canceled')),
  deadline_at timestamptz not null,
  result jsonb check(result is null or (jsonb_typeof(result)='object' and octet_length(result::text)<=16384)),
  resolution_evidence text check(resolution_evidence is null or length(btrim(resolution_evidence)) between 1 and 2000),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique(idempotency_scope,idempotency_key),
  unique(id,call_id),
  check(deadline_at > created_at),
  check((state in ('succeeded','failed','canceled')) = (resolved_at is not null)),
  check(resolved_at is null or (resolved_at >= created_at and resolution_evidence is not null)),
  check(state <> 'succeeded' or result is not null)
);
create index call_operations_work_idx on call_operations(state,deadline_at,id) where resolved_at is null;
create index call_operations_call_idx on call_operations(call_id);

create function guard_call_operation() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.resolved_at is null or exists(select 1 from calls where id=old.call_id and
      (ended_at is null or state not in ('completed','failed','canceled')))
      or exists(select 1 from call_capacity_reservations where operation_id=old.id and state <> 'released') then
      raise exception 'Unresolved operation and live-call idempotency must be retained' using errcode='23514';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - array['state','result','resolution_evidence','resolved_at'])
    is distinct from (to_jsonb(old) - array['state','result','resolution_evidence','resolved_at'])
    or (old.resolved_at is not null and new is distinct from old)
    or (old.state='uncertain' and new.state not in ('uncertain','succeeded','failed','canceled'))
    or (old.state='executing' and new.state='pending') then
    raise exception 'Operation identity is fixed; terminal/uncertain work cannot be replayed as pending' using errcode='23514';
  end if;
  return new;
end $$;
create trigger call_operations_guard before update or delete on call_operations
  for each row execute function guard_call_operation();

-- Binding revisions are snapshots: later Desk/campaign changes cannot rewrite
-- an offer's original recipient identity or reset its deadline.
alter table agent_desk_sessions add constraint agent_desk_sessions_id_agent_unique unique(id,agent_id);
create table call_transfers (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete restrict,
  attempt integer not null check(attempt > 0),
  source_agent_id uuid not null references agents(id),
  source_participant_id uuid not null,
  recipient_agent_id uuid not null references agents(id),
  operation_id uuid,
  state text not null default 'offered' check(state in
    ('offered','connecting','switching','uncertain','completed','declined','expired','canceled','failed')),
  deadline_at timestamptz not null,
  closed_at timestamptz,
  reason text check(reason is null or length(btrim(reason)) between 1 and 200),
  created_at timestamptz not null default now(),
  unique(call_id,attempt),
  unique(id,call_id,recipient_agent_id),
  foreign key(source_participant_id,call_id,source_agent_id) references call_participants(id,call_id,agent_id),
  foreign key(operation_id,call_id) references call_operations(id,call_id),
  check(source_agent_id <> recipient_agent_id),
  check(deadline_at > created_at),
  check((state in ('completed','declined','expired','canceled','failed')) = (closed_at is not null)),
  check((closed_at is null) = (reason is null)),
  check(closed_at is null or closed_at >= created_at)
);
create unique index call_transfers_one_unfinished_idx on call_transfers(call_id) where closed_at is null;

create table call_offers (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete restrict,
  kind text not null check(kind in ('inbound','transfer')),
  transfer_id uuid,
  agent_id uuid not null references agents(id),
  attempt integer not null check(attempt > 0),
  desk_session_id uuid not null,
  desk_revision bigint not null check(desk_revision > 0),
  binding_generation bigint not null check(binding_generation > 0),
  deadline_at timestamptz not null,
  state text not null default 'pending' check(state in ('pending','accepted','ignored','expired','declined','canceled','failed')),
  reason text check(reason is null or length(btrim(reason)) between 1 and 200),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(call_id,agent_id,kind,attempt),
  unique(id,call_id,agent_id),
  foreign key(desk_session_id,agent_id) references agent_desk_sessions(id,agent_id),
  foreign key(transfer_id,call_id,agent_id) references call_transfers(id,call_id,recipient_agent_id),
  check((kind='transfer') = (transfer_id is not null)),
  check(deadline_at > created_at),
  check((state <> 'pending') = (closed_at is not null)),
  check((closed_at is null) = (reason is null)),
  check(closed_at is null or closed_at >= created_at),
  check(state <> 'ignored' or (kind='inbound' and reason in ('user_ignored','manual_outbound_started'))),
  check(state <> 'declined' or kind='transfer'),
  check(state <> 'expired' or reason='deadline_elapsed'),
  check(reason is distinct from 'winner_accepted' or state='canceled')
);
create unique index call_offers_one_open_agent_idx on call_offers(agent_id) where state='pending';
create index call_offers_dispatch_idx on call_offers(call_id,attempt,state);
create index call_offers_deadline_idx on call_offers(deadline_at,id) where state='pending';

create table call_offer_exclusions (
  call_id uuid not null references calls(id) on delete restrict,
  agent_id uuid not null references agents(id),
  offer_id uuid not null unique,
  reason text not null check(reason in ('user_ignored','manual_outbound_started','deadline_elapsed')),
  excluded_at timestamptz not null,
  primary key(call_id,agent_id),
  foreign key(offer_id,call_id,agent_id) references call_offers(id,call_id,agent_id) on delete restrict
);

create function guard_call_offer_exclusion() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from calls where id=old.call_id and
      (ended_at is null or state not in ('completed','failed','canceled'))) then
      raise exception 'Live-call exclusion must survive attempts and Desk changes' using errcode='23514';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    raise exception 'Exclusion history is immutable' using errcode='23514';
  end if;
  if not exists(select 1 from call_offers where id=new.offer_id and call_id=new.call_id
    and agent_id=new.agent_id and kind='inbound' and state in ('ignored','expired')
    and reason=new.reason and closed_at=new.excluded_at) then
    raise exception 'Only ignored/expired inbound offers create exclusions' using errcode='23514';
  end if;
  return new;
end $$;
create trigger call_offer_exclusions_guard before insert or update or delete on call_offer_exclusions
  for each row execute function guard_call_offer_exclusion();

create function capture_call_offer_exclusion() returns trigger language plpgsql as $$
begin
  if new.kind='inbound' and new.state in ('ignored','expired') then
    insert into call_offer_exclusions(call_id,agent_id,offer_id,reason,excluded_at)
    values(new.call_id,new.agent_id,new.id,new.reason,new.closed_at)
    on conflict(call_id,agent_id) do nothing;
  end if;
  return new;
end $$;
create trigger call_offers_capture_exclusion after insert or update on call_offers
  for each row execute function capture_call_offer_exclusion();

-- Reusable history guard: identities/deadlines never change; only lifecycle
-- fields passed as trigger arguments may change before closure.
create function guard_closed_call_work() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.closed_at is null or exists(select 1 from calls where id=old.call_id and
      (ended_at is null or state not in ('completed','failed','canceled'))) then
      raise exception 'Open work and live-call history must be retained' using errcode='23514';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - tg_argv) is distinct from (to_jsonb(old) - tg_argv)
    or (old.closed_at is not null and new is distinct from old) then
    raise exception 'Work identity and closed history are immutable' using errcode='23514';
  end if;
  if tg_table_name='call_transfers' then
    if old.operation_id is not null and new.operation_id is distinct from old.operation_id then
      raise exception 'Transfer operation identity is fixed once assigned' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
create trigger call_offers_history_guard before update or delete on call_offers
  for each row execute function guard_closed_call_work('state','closed_at','reason');
create trigger call_transfers_history_guard before update or delete on call_transfers
  for each row execute function guard_closed_call_work('state','closed_at','reason','operation_id');

create table agent_auto_next_intents (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  source_call_id uuid not null references calls(id) on delete restrict,
  campaign_id uuid not null references campaigns(id),
  desk_session_id uuid not null,
  desk_revision bigint not null check(desk_revision > 0),
  idempotency_key uuid not null unique,
  state text not null default 'pending' check(state in ('pending','deferred','started','canceled')),
  reason text check(reason is null or length(btrim(reason)) between 1 and 200),
  started_call_id uuid references calls(id) on delete restrict,
  operation_id uuid,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(agent_id,source_call_id),
  foreign key(desk_session_id,agent_id) references agent_desk_sessions(id,agent_id),
  foreign key(operation_id,started_call_id) references call_operations(id,call_id),
  check((state in ('started','canceled')) = (closed_at is not null)),
  check((state='started') = (started_call_id is not null and operation_id is not null)),
  check(state='started' or (started_call_id is null and operation_id is null)),
  check(state not in ('deferred','canceled') or reason is not null),
  check(closed_at is null or closed_at >= created_at)
);
create index agent_auto_next_pending_idx on agent_auto_next_intents(agent_id) where closed_at is null;
create function guard_auto_next_intent() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.closed_at is null then
      raise exception 'Deferred intent must be retained or explicitly canceled' using errcode='23514';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - array['state','reason','started_call_id','operation_id','closed_at'])
    is distinct from (to_jsonb(old) - array['state','reason','started_call_id','operation_id','closed_at'])
    or (old.closed_at is not null and new is distinct from old) then
    raise exception 'Source completion and started/canceled intent are immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger agent_auto_next_intents_guard before update or delete on agent_auto_next_intents
  for each row execute function guard_auto_next_intent();

-- Internal FS UUID is the deduplication identity, never a provider SIP header.
-- call_id is optional: terminal-only evidence can precede any product call.
create table inbound_ingress_evidence (
  ingress_id uuid primary key,
  journal_id text not null check(length(btrim(journal_id)) between 1 and 200),
  arrived_at timestamptz not null,
  validated_did text not null check(length(validated_did) between 1 and 64),
  route_revision bigint not null check(route_revision > 0),
  queue_deadline_at timestamptz not null check(queue_deadline_at > arrived_at),
  evidence_sequence bigint not null check(evidence_sequence > 0),
  imported_sequence bigint not null default 0 check(imported_sequence >= 0 and imported_sequence <= evidence_sequence),
  acknowledged_sequence bigint not null default 0 check(acknowledged_sequence >= 0 and acknowledged_sequence <= imported_sequence),
  terminal_at timestamptz,
  terminal_reason text check(terminal_reason is null or length(btrim(terminal_reason)) between 1 and 200),
  call_id uuid unique references calls(id) on delete restrict,
  created_at timestamptz not null default now(),
  check((terminal_at is null) = (terminal_reason is null)),
  check(terminal_at is null or terminal_at >= arrived_at)
);
create index inbound_ingress_import_idx on inbound_ingress_evidence(journal_id,evidence_sequence)
  where acknowledged_sequence < evidence_sequence;
create function guard_ingress_evidence() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.terminal_at is null or old.acknowledged_sequence <> old.evidence_sequence then
      raise exception 'Unacknowledged or live ingress evidence must be retained' using errcode='23514';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    if row(new.ingress_id,new.journal_id,new.arrived_at,new.validated_did,new.route_revision,new.queue_deadline_at,new.created_at)
      is distinct from row(old.ingress_id,old.journal_id,old.arrived_at,old.validated_did,old.route_revision,old.queue_deadline_at,old.created_at)
      or (old.call_id is not null and new.call_id is distinct from old.call_id)
      or new.evidence_sequence < old.evidence_sequence or new.imported_sequence < old.imported_sequence
      or new.acknowledged_sequence < old.acknowledged_sequence
      or (old.terminal_at is not null and row(new.terminal_at,new.terminal_reason) is distinct from row(old.terminal_at,old.terminal_reason))
      or (row(new.terminal_at,new.terminal_reason) is distinct from row(old.terminal_at,old.terminal_reason)
        and new.evidence_sequence <= old.evidence_sequence) then
      raise exception 'Ingress identity, age and terminal evidence cannot regress' using errcode='23514';
    end if;
  end if;
  if new.terminal_at is not null and new.call_id is not null and not exists
    (select 1 from calls where id=new.call_id and ended_at is not null and state in ('completed','failed','canceled')) then
    raise exception 'Terminal evidence may only link to terminal history' using errcode='23514';
  end if;
  return new;
end $$;
create trigger inbound_ingress_evidence_guard before insert or update or delete on inbound_ingress_evidence
  for each row execute function guard_ingress_evidence();

create function guard_ingress_terminal_call() returns trigger language plpgsql as $$
begin
  if (new.ended_at is null or new.state not in ('completed','failed','canceled')) and exists
    (select 1 from inbound_ingress_evidence where call_id=old.id and terminal_at is not null) then
    raise exception 'Terminal ingress cannot resurrect a live call' using errcode='23514';
  end if;
  return new;
end $$;
create trigger calls_ingress_terminal_guard before update of ended_at,state on calls
  for each row execute function guard_ingress_terminal_call();
