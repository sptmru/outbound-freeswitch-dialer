-- F03: immutable flow identity; operation rows retain per-step execution/evidence.
create table inbound_fallback_runs (
  call_id uuid primary key references calls(id),
  flow_version_id uuid references inbound_flow_versions(id),
  started_at timestamptz not null,
  deadline_at timestamptz not null,
  check(deadline_at > started_at)
);
create function preserve_inbound_fallback_run() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' or exists(select 1 from calls where id=old.call_id and ended_at is null)
    or exists(select 1 from call_operations where call_id=old.call_id and resolved_at is null) then
    raise exception 'Fallback identity must survive until drained retention' using errcode='23514';
  end if;
  return old;
end $$;
create trigger inbound_fallback_run_guard before update or delete on inbound_fallback_runs
for each row execute function preserve_inbound_fallback_run();
