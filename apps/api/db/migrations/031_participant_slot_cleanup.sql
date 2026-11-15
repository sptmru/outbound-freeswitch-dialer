-- Nullable snapshots preserve legacy writers. A participation owns exactly one
-- reservation; returning A -> B -> A creates a new participation, never a new
-- token on the old history row. No migration/cutover marker is enabled here.
-- Serialize snapshot backfill and trigger installation with existing native
-- producers; no reservation may slip between those two steps.
select pg_advisory_xact_lock(72202,0);
lock table agent_call_slots, call_participants in share row exclusive mode;
alter table call_participants
  add column slot_reservation_id uuid,
  add column slot_generation bigint,
  add constraint call_participants_slot_snapshot check(
    (slot_reservation_id is null) = (slot_generation is null)
    and (slot_generation is null or (role='agent' and slot_generation > 0)));
create unique index call_participants_slot_reservation_idx on call_participants(slot_reservation_id)
  where slot_reservation_id is not null;

update call_participants p set slot_reservation_id=s.reservation_id,slot_generation=s.generation
from agent_call_slots s where s.participant_id=p.id and s.call_id=p.call_id
  and s.agent_id=p.agent_id and s.state<>'free' and p.origin='native';

create function preserve_participant_slot_snapshot() returns trigger language plpgsql as $$
begin
  if old.slot_reservation_id is not null and
    row(new.slot_reservation_id,new.slot_generation) is distinct from
    row(old.slot_reservation_id,old.slot_generation) then
    raise exception 'Participant reservation snapshot is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger call_participant_slot_snapshot_guard before update on call_participants
  for each row execute function preserve_participant_slot_snapshot();

create function capture_participant_slot_snapshot() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and old.state<>'free' and new.state<>'free'
    and old.participant_id is not null and new.participant_id is distinct from old.participant_id then
    raise exception 'Occupied reservation participation is immutable' using errcode='23514';
  end if;
  if new.participant_id is not null and new.state<>'free' then
    update call_participants set slot_reservation_id=new.reservation_id,slot_generation=new.generation
      where id=new.participant_id and call_id=new.call_id and agent_id=new.agent_id and origin='native';
  end if;
  return new;
end $$;
create trigger agent_call_slots_capture_participant after insert or update on agent_call_slots
  for each row execute function capture_participant_slot_snapshot();
