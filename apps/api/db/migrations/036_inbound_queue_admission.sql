-- D04 additive staged admission. Inbound context must not claim an outbound lead.
alter table calls add column inbound_context_contact_id uuid references contacts(id) on delete set null,
  add column inbound_end_reason text;
create table inbound_queue_admissions (
  call_id uuid primary key references calls(id) on delete restrict,
  operation_id uuid not null unique,
  waiting_audio_id uuid references recordings(id),
  admitted_at timestamptz not null default clock_timestamp(),
  foreign key(operation_id,call_id) references call_operations(id,call_id)
);
create function preserve_inbound_admission() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' or exists(select 1 from calls where id=old.call_id and ended_at is null) then
    raise exception 'Inbound admission identity is immutable until drained retention' using errcode='23514';
  end if;
  return old;
end $$;
create trigger inbound_queue_admissions_guard before update or delete on inbound_queue_admissions
  for each row execute function preserve_inbound_admission();
-- Keep terminal reason/timestamps monotonic, including late native events.
create function preserve_inbound_terminal() returns trigger language plpgsql as $$
begin
  if old.direction='inbound' and new.queue_deadline_at is distinct from old.queue_deadline_at
    and exists(select 1 from inbound_ingress_evidence where call_id=old.id) then
    raise exception 'Captured inbound queue deadline is immutable' using errcode='23514';
  end if;
  if old.direction='inbound' and old.ended_at is not null and
    row(new.state,new.outcome,new.ended_at,new.inbound_end_reason,new.pstn_answered_at,new.agent_connected_at)
      is distinct from row(old.state,old.outcome,old.ended_at,old.inbound_end_reason,old.pstn_answered_at,old.agent_connected_at) then
    raise exception 'Terminal inbound lifecycle cannot regress' using errcode='23514';
  end if;
  return new;
end $$;
create trigger calls_inbound_terminal_guard before update on calls
  for each row execute function preserve_inbound_terminal();
