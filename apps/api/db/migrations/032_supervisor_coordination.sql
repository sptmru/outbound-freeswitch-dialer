-- Additive, feature-off C07 protocol. Existing legacy sessions are not reclassified.
alter table call_supervisor_sessions
  add column coordination_protocol text not null default 'legacy' check(coordination_protocol in ('legacy','native')),
  add column generation bigint not null default 1 check(generation>0),
  add column control_root_id uuid,
  add foreign key(control_root_id,call_id) references call_operations(id,call_id);

create table supervisor_leg_evidence (
  supervisor_leg_uuid uuid primary key,
  session_id uuid not null,
  call_id uuid not null,
  generation bigint not null check(generation>0),
  originate_operation_id uuid not null unique,
  answered_at timestamptz,
  ended_at timestamptz,
  terminal_evidence text,
  created_at timestamptz not null default clock_timestamp(),
  unique(session_id,generation),
  foreign key(session_id,call_id) references call_supervisor_sessions(id,call_id) on delete cascade,
  foreign key(originate_operation_id,call_id) references call_operations(id,call_id),
  check((ended_at is null)=(terminal_evidence is null))
);
create function guard_supervisor_leg_evidence() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['answered_at','ended_at','terminal_evidence']) is distinct from
     (to_jsonb(old)-array['answered_at','ended_at','terminal_evidence'])
     or (old.answered_at is not null and new.answered_at is distinct from old.answered_at)
     or (old.ended_at is not null and new is distinct from old) then
    raise exception 'Supervisor leg identity and terminal evidence are immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger supervisor_leg_evidence_guard before update on supervisor_leg_evidence
  for each row execute function guard_supervisor_leg_evidence();
