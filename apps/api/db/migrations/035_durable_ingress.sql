-- Additive D03 evidence. Does not enable routing or enqueue calls.
alter table inbound_ingress_evidence add column route_snapshot jsonb,
  add column calling_number text;
create function guard_ingress_snapshot() returns trigger language plpgsql as $$
begin
  if old.route_snapshot is not null and
    row(new.route_snapshot,new.calling_number) is distinct from row(old.route_snapshot,old.calling_number) then
    raise exception 'Captured ingress route snapshot is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger inbound_ingress_snapshot_guard before update on inbound_ingress_evidence
  for each row execute function guard_ingress_snapshot();

-- Pin every rendered enabled route BEFORE publishing it to FS. A process may
-- die after reload but before applied_revision is committed. Keeping these rows
-- prevents deletion/reparenting of queues needed by unimported durable captures.
-- H04 owns safe archival/drain/retention, not a timeout-based deletion here.
create table inbound_ingress_route_snapshots (
  configuration_hash text not null check(configuration_hash ~ '^[0-9a-f]{64}$'),
  number_id uuid not null,
  queue_id uuid not null,
  campaign_id uuid not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key(configuration_hash,number_id),
  foreign key(queue_id,campaign_id) references inbound_queues(id,campaign_id) on delete restrict
);
create function guard_published_ingress_route() returns trigger language plpgsql as $$
begin
  raise exception 'Published ingress snapshots require explicit drained retention' using errcode='23514';
end $$;
create trigger inbound_ingress_route_snapshot_guard before update or delete on inbound_ingress_route_snapshots
  for each row execute function guard_published_ingress_route();
