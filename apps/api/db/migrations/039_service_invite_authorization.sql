-- One physical SIP dialog per durable service operation. HTTP replay cannot
-- authorize a replacement dialog after reconnect, reload or ambiguous delivery.
create table service_invite_dialogs (
  operation_id uuid primary key references call_operations(id) on delete cascade,
  dialog_id text not null check(length(dialog_id) between 1 and 255),
  authorized_at timestamptz not null default clock_timestamp()
);
create function preserve_service_invite_dialog() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' or exists(select 1 from call_operations o join calls c on c.id=o.call_id
    where o.id=old.operation_id and (c.ended_at is null or o.resolved_at is null)) then
    raise exception 'Service dialog identity must survive live or uncertain work' using errcode='23514';
  end if;
  return old;
end $$;
create trigger service_invite_dialog_guard before update or delete on service_invite_dialogs
  for each row execute function preserve_service_invite_dialog();
