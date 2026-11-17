-- Additive G01 replay history. G02 owns media execution and confirmed handover.
create table transfer_offer_mutations (
  actor_user_id uuid not null references users(id),
  idempotency_key uuid not null,
  transfer_id uuid not null references call_transfers(id) on delete restrict,
  request_fingerprint text not null check(request_fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb not null check(jsonb_typeof(response)='object' and octet_length(response::text)<=16384),
  primary key(actor_user_id,idempotency_key)
);
create function preserve_transfer_offer_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' or exists(select 1 from call_transfers t join calls c on c.id=t.call_id
    where t.id=old.transfer_id and (c.ended_at is null or t.closed_at is null or
      exists(select 1 from call_operations o where o.call_id=c.id and o.resolved_at is null))) then
    raise exception 'Transfer replay identity is immutable until drained retention' using errcode='23514';
  end if;
  return old;
end $$;
create trigger transfer_offer_mutation_guard before update or delete on transfer_offer_mutations
  for each row execute function preserve_transfer_offer_mutation();
