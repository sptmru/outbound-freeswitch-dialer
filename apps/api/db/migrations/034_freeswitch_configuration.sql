-- D02: one deployment-wide configuration publisher. No routes are seeded/enabled.
create table inbound_freeswitch_configuration (
  singleton boolean primary key default true check (singleton),
  desired_revision bigint not null default 1 check (desired_revision > 0),
  desired_hash text,
  applied_revision bigint check (applied_revision > 0 and applied_revision <= desired_revision),
  applied_hash text,
  applied_xml text,
  verified_at timestamptz,
  error_revision bigint,
  apply_error text,
  check ((applied_hash is null) = (applied_xml is null))
);
insert into inbound_freeswitch_configuration(singleton) values(true);

-- Serialize edits with the session-level publisher lock. This lock belongs only
-- to configuration, never to call admission/execution. BEFORE STATEMENT prevents
-- row-lock -> publisher-lock inversion even for UPDATE/DELETE and FK cascades.
create function inbound_fs_configuration_lock() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(72204, 0);
  return null;
end;
$$;
create function inbound_fs_configuration_changed() returns trigger language plpgsql as $$
begin
  update inbound_freeswitch_configuration set desired_revision=desired_revision+1,
    desired_hash=null, verified_at=null, apply_error=null, error_revision=null;
  return null;
end;
$$;
create trigger inbound_numbers_fs_lock before insert or update or delete on inbound_numbers
for each statement execute function inbound_fs_configuration_lock();
create trigger inbound_queues_fs_lock before insert or update or delete on inbound_queues
for each statement execute function inbound_fs_configuration_lock();
-- Applying per-entity revisions must not itself create a new desired revision.
create trigger inbound_numbers_fs_changed after insert or delete or update of normalized_did,label,queue_id,enabled on inbound_numbers
for each statement execute function inbound_fs_configuration_changed();
create trigger inbound_queues_fs_changed after insert or delete or update of campaign_id,name,waiting_audio_id,no_answer_flow_version_id,
  offer_timeout_ms,queue_timeout_ms,connect_timeout_ms,transfer_timeout_ms,max_waiting_calls,overflow_policy,overflow_flow_version_id on inbound_queues
for each statement execute function inbound_fs_configuration_changed();
