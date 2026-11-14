-- Additive, feature-off foundation. Legacy writers still bypass these tables.
-- Freeze their snapshot only for this transaction; do not infer media absence.
lock table agents, calls, call_legs, call_supervisor_sessions in share row exclusive mode;

create table agent_desk_sessions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete restrict,
  campaign_id uuid references campaigns(id) on delete restrict,
  revision bigint not null default 1 check (revision > 0),
  binding_generation bigint not null check (binding_generation > 0),
  sip_username text not null unique check (length(sip_username) between 1 and 128),
  sip_secret_encrypted text,
  verified_endpoint text,
  verified_generation bigint,
  verified_at timestamptz,
  ready boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_id, binding_generation),
  check (expires_at > created_at),
  check ((verified_endpoint is null and verified_generation is null and verified_at is null)
    or (verified_endpoint is not null and length(verified_endpoint) > 0 and verified_generation is not null
      and verified_generation = binding_generation and verified_at is not null)),
  check (not ready or (revoked_at is null and verified_generation is not null))
);
-- Expired controllers remain identities until explicitly revoked; expiry is not takeover.
create unique index agent_desk_sessions_one_controller_idx
  on agent_desk_sessions(agent_id) where revoked_at is null;

create table agent_call_slots (
  agent_id uuid primary key references agents(id) on delete cascade,
  state text not null default 'uncertain'
    check (state in ('free','reserved','connecting','active','releasing','uncertain')),
  call_id uuid references calls(id) on delete restrict,
  -- B03 adds the participant relation; no fabricated participant is backfilled.
  participant_id uuid,
  reservation_id uuid unique default gen_random_uuid(),
  generation bigint not null default 1 check (generation > 0),
  reconciliation_required boolean not null default true,
  updated_at timestamptz not null default now(),
  check ((state = 'free' and call_id is null and participant_id is null
      and reservation_id is null and not reconciliation_required)
    or (state <> 'free' and reservation_id is not null
      and (call_id is not null or (state = 'uncertain' and reconciliation_required)))),
  check (not reconciliation_required or state = 'uncertain')
);

create function fence_agent_call_slot() returns trigger language plpgsql as $$
begin
  if new.agent_id <> old.agent_id then
    raise exception 'Slot agent identity is immutable' using errcode = '23514';
  end if;
  if old.state = 'free' and new.state <> 'free' then
    if new.state <> 'reserved' or new.reservation_id is not distinct from old.reservation_id then
      raise exception 'A new claim must reserve a new identity' using errcode = '23514';
    end if;
    new.generation := old.generation + 1;
  else
    if new.generation <> old.generation then
      raise exception 'Only a new reservation advances generation' using errcode = '23514';
    end if;
    if old.state <> 'free' and new.state <> 'free' and
      (new.call_id is distinct from old.call_id or new.reservation_id is distinct from old.reservation_id) then
      raise exception 'Occupied slot ownership is immutable' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger agent_call_slots_fence before update on agent_call_slots
  for each row execute function fence_agent_call_slot();

create unique index call_legs_id_call_id_idx on call_legs(id,call_id);
create unique index call_supervisor_sessions_id_call_id_idx on call_supervisor_sessions(id,call_id);

create table call_capacity_reservations (
  id uuid primary key default gen_random_uuid(),
  -- B04 will supply durable operations; stable UUIDs are recorded before then.
  operation_id uuid not null,
  call_id uuid not null references calls(id) on delete restrict,
  agent_id uuid references agents(id) on delete restrict,
  call_leg_id uuid,
  supervisor_session_id uuid,
  resource_type text not null check (resource_type in
    ('queue_waiting','customer_channel','browser_channel','supervisor_channel',
     'transfer_overlap','trunk_call','external_forward')),
  scope_id text not null check (length(scope_id) between 1 and 200),
  units integer not null default 1 check (units > 0),
  generation bigint not null default 1 check (generation > 0),
  state text not null default 'reserved'
    check (state in ('reserved','in_use','releasing','uncertain','released')),
  origin text not null default 'admission' check (origin in ('admission','legacy_backfill')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  foreign key (call_leg_id,call_id) references call_legs(id,call_id) on delete restrict,
  foreign key (supervisor_session_id,call_id) references call_supervisor_sessions(id,call_id) on delete restrict,
  unique (operation_id, resource_type, scope_id),
  check ((state = 'released') = (released_at is not null))
);
create index call_capacity_reservations_usage_idx
  on call_capacity_reservations(resource_type,scope_id) where state <> 'released';
create index call_capacity_reservations_call_idx on call_capacity_reservations(call_id);

create function fence_call_capacity_reservation() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if row(new.id,new.operation_id,new.call_id,new.agent_id,new.call_leg_id,
           new.supervisor_session_id,new.resource_type,new.scope_id,new.units,new.generation,new.origin)
      is distinct from
       row(old.id,old.operation_id,old.call_id,old.agent_id,old.call_leg_id,
           old.supervisor_session_id,old.resource_type,old.scope_id,old.units,old.generation,old.origin)
      or (old.state = 'released' and new is distinct from old) then
      raise exception 'Capacity ownership is immutable; released claims cannot be reused' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger call_capacity_reservations_fence before insert or update on call_capacity_reservations
  for each row execute function fence_call_capacity_reservation();

-- All agents start unavailable to the future protocol, even when no call row exists.
-- Reconciliation must also inspect FS orphans and unresolved legacy sends.
insert into agent_call_slots(agent_id,call_id)
select a.id, (
  select c.id from calls c where c.agent_id = a.id
    and ((c.ended_at is null and c.state not in ('completed','failed','canceled')
      and c.agent_released_at is null and c.state <> 'agent_released')
      or exists (select 1 from call_legs l where l.call_id = c.id and l.type = 'agent'
        and l.ended_at is null and l.freeswitch_uuid is not null
        and l.state not in ('completed','failed','canceled','ended','hangup','released')))
  order by c.created_at desc,c.id limit 1
) from agents a;

create function initialize_agent_call_slot() returns trigger language plpgsql as $$
begin
  insert into agent_call_slots(agent_id) values (new.id);
  return new;
end $$;
create trigger agents_initialize_call_slot after insert on agents
  for each row execute function initialize_agent_call_slot();

-- Preserve legacy deletion of agents with only an unclaimed initialization row.
-- A recipient's real reservation must survive even when calls.agent_id is another agent.
create function guard_agent_slot_deletion() returns trigger language plpgsql as $$
begin
  perform 1 from agent_call_slots where agent_id = old.id for update;
  if exists (select 1 from agent_call_slots where agent_id = old.id
    and state <> 'free' and (call_id is not null or not reconciliation_required)) then
    raise exception 'Cannot delete agent with occupied slot' using errcode = '23503';
  end if;
  return old;
end $$;
create trigger agents_guard_occupied_slot before delete on agents
  for each row execute function guard_agent_slot_deletion();

-- Count every known unfinished customer leg, plus pre-originate intent when there
-- is not yet a UUID. Terminal calls with residual legs remain conservatively counted.
with candidates as (
  select c.*, greatest(1,(select count(*)::int from call_legs l where l.call_id = c.id
    and l.type = 'customer' and l.ended_at is null
    and l.state not in ('completed','failed','canceled','ended','hangup','released'))) as customer_units
  from calls c where (c.ended_at is null and c.state not in ('completed','failed','canceled'))
    or exists (select 1 from call_legs l where l.call_id = c.id and l.ended_at is null
      and l.freeswitch_uuid is not null
      and l.state not in ('completed','failed','canceled','ended','hangup','released'))
)
insert into call_capacity_reservations(operation_id,call_id,resource_type,scope_id,units,state,origin)
select c.id,c.id,r.resource_type,r.scope_id,c.customer_units,'uncertain','legacy_backfill'
from candidates c cross join (values
  ('customer_channel','deployment'),('trunk_call','default')) r(resource_type,scope_id);

insert into call_capacity_reservations(operation_id,call_id,agent_id,resource_type,scope_id,units,state,origin)
select c.id,c.id,c.agent_id,'browser_channel','deployment',greatest(1,
  (select count(*)::int from call_legs l where l.call_id = c.id and l.type = 'agent'
    and l.ended_at is null and l.state not in ('completed','failed','canceled','ended','hangup','released'))),
  'uncertain','legacy_backfill'
from calls c where
  (c.ended_at is null and c.state not in ('completed','failed','canceled','agent_released')
    and c.agent_released_at is null and c.agent_id is not null)
  or exists (select 1 from call_legs l where l.call_id = c.id and l.type = 'agent'
    and l.ended_at is null and l.freeswitch_uuid is not null
    and l.state not in ('completed','failed','canceled','ended','hangup','released'));

insert into call_capacity_reservations(operation_id,call_id,supervisor_session_id,resource_type,scope_id,state,origin)
select s.id,s.call_id,s.id,'supervisor_channel','deployment','uncertain','legacy_backfill'
from call_supervisor_sessions s where s.ended_at is null or s.state in ('connecting','active');

-- Evidence marker, not an enable switch. C01/I05 must implement the guarded gate.
create table call_admission_migration (
  singleton boolean primary key default true check (singleton),
  reconciliation_required boolean not null default true,
  captured_at timestamptz not null default now(),
  reconciled_at timestamptz,
  check (reconciliation_required or reconciled_at is not null)
);
insert into call_admission_migration default values;
