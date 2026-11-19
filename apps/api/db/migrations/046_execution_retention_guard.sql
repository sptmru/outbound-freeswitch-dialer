-- A trigger record has only the fields of its table. Branch before accessing
-- those fields so FK cascades can remove execution evidence with its parent.
create or replace function guard_call_execution_identity() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' then
    raise exception 'Execution keys and sender identities are immutable' using errcode='23514';
  end if;
  if tg_table_name='call_execution_keys' then
    if exists(select 1 from calls where id=old.call_id) then
      raise exception 'Execution key must survive the call' using errcode='23514';
    end if;
  elsif exists(select 1 from call_operations where id=old.operation_id) then
    raise exception 'Sender identity must survive its operation' using errcode='23514';
  end if;
  return old;
end $$;
