-- Additive, feature-off executor metadata. Legacy operations remain readable.
-- One collision-free key per product call, shared by all of its operations.
create table call_execution_keys (
  call_id uuid primary key references calls(id) on delete cascade,
  lock_key integer generated always as identity unique
);
create table call_execution_attempts (
  operation_id uuid primary key references call_operations(id) on delete cascade,
  owner_id uuid not null,
  backend_pid integer not null,
  replica integer not null check(replica between 0 and 1),
  seat integer not null check(seat between 0 and 3),
  started_at timestamptz not null default clock_timestamp()
);
create function guard_call_execution_identity() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' then
    raise exception 'Execution keys and sender identities are immutable' using errcode='23514';
  end if;
  if tg_table_name='call_execution_keys' and exists(select 1 from calls where id=old.call_id) then
    raise exception 'Execution key must survive the call' using errcode='23514';
  elsif tg_table_name='call_execution_attempts' and exists(select 1 from call_operations where id=old.operation_id) then
    raise exception 'Sender identity must survive its operation' using errcode='23514';
  end if;
  return old;
end $$;
create trigger call_execution_keys_guard before update or delete on call_execution_keys
  for each row execute function guard_call_execution_identity();
create trigger call_execution_attempts_guard before update or delete on call_execution_attempts
  for each row execute function guard_call_execution_identity();
