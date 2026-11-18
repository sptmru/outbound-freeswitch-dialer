-- Additive opt-in transport protocol. Existing unfenced attempts stay unknown.
alter table call_execution_attempts add column transport_protocol text
  check(transport_protocol is null or transport_protocol='fs-fenced-v1');
create table call_command_fences (
  operation_id uuid primary key references call_execution_attempts(operation_id) on delete cascade,
  core_uuid uuid not null,
  armed_at timestamptz not null default clock_timestamp()
);
create function preserve_command_fence() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' or exists(select 1 from call_operations where id=old.operation_id) then
    raise exception 'Command incarnation proof must survive its operation' using errcode='23514';
  end if;
  return old;
end $$;
create trigger call_command_fences_guard before update or delete on call_command_fences
  for each row execute function preserve_command_fence();
create table call_command_receipt_acks (
  operation_id uuid primary key references call_command_fences(operation_id) on delete cascade,
  acknowledged_at timestamptz not null default clock_timestamp()
);
