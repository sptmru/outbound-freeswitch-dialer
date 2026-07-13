alter table users
  add column if not exists auth_version integer not null default 1;

alter table calls
  add column if not exists call_recording_status text not null default 'disabled';

alter table calls
  add column if not exists call_recording_duration_seconds integer;

alter table calls
  add column if not exists call_recording_file_size_bytes bigint;

alter table calls
  add column if not exists call_recording_integrity_checked_at timestamptz;

alter table calls
  add column if not exists call_recording_failure_reason text;

update calls
set call_recording_status = case
  when call_recording_enabled = false then 'disabled'
  when call_recording_path is not null then 'pending'
  else 'failed'
end
where call_recording_status = 'disabled'
  and call_recording_enabled = true;

create table if not exists admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  request_id text not null,
  method text not null,
  route text not null,
  status_code integer not null,
  source_ip text,
  user_agent text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_events_created_at_idx
  on admin_audit_events(created_at desc);

create index if not exists admin_audit_events_actor_idx
  on admin_audit_events(actor_user_id, created_at desc);

create index if not exists calls_campaign_outcome_idx
  on calls(campaign_id, outcome);

create unique index if not exists agents_one_per_user_idx
  on agents(user_id);

update recordings
set is_default = false,
    updated_at = now()
where is_active = false and is_default = true;

with ranked_defaults as (
  select id,
         row_number() over (order by updated_at desc, created_at desc, id desc) as position
  from recordings
  where is_active = true and is_default = true
)
update recordings
set is_default = false,
    updated_at = now()
where id in (select id from ranked_defaults where position > 1);

create unique index if not exists recordings_one_active_default_idx
  on recordings(is_default)
  where is_active = true and is_default = true;

create unique index if not exists call_legs_freeswitch_uuid_unique_idx
  on call_legs(freeswitch_uuid)
  where freeswitch_uuid is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaigns_status_valid') then
    alter table campaigns add constraint campaigns_status_valid
      check (status in ('active', 'paused', 'draft', 'archived')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_status_valid') then
    alter table contacts add constraint contacts_status_valid
      check (status in ('new', 'calling', 'completed', 'suppressed')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_attempt_count_valid') then
    alter table contacts add constraint contacts_attempt_count_valid
      check (attempt_count >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_auth_version_valid') then
    alter table users add constraint users_auth_version_valid
      check (auth_version > 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_status_valid') then
    alter table agents add constraint agents_status_valid
      check (status in ('offline', 'ready', 'registered', 'in_call')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recordings_default_is_active') then
    alter table recordings add constraint recordings_default_is_active
      check (not is_default or is_active) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_state_valid') then
    alter table calls add constraint calls_state_valid
      check (state in (
        'created', 'agent_ringing', 'agent_answered', 'customer_dialing',
        'customer_ringing', 'bridged', 'voicemail_signal_detected',
        'voicemail_drop_requested', 'voicemail_playback_started', 'agent_released',
        'voicemail_playback_completed', 'completed', 'failed', 'canceled'
      )) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_outcome_valid') then
    alter table calls add constraint calls_outcome_valid
      check (outcome is null or outcome in (
        'answered', 'not_answered', 'busy', 'failed', 'voicemail_detected',
        'voicemail_dropped', 'agent_canceled', 'customer_hung_up', 'suppressed'
      )) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_recording_status_valid') then
    alter table calls add constraint calls_recording_status_valid
      check (call_recording_status in ('disabled', 'pending', 'recording', 'finalizing', 'available', 'expired', 'failed')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calls_recording_metadata_valid') then
    alter table calls add constraint calls_recording_metadata_valid
      check (
        (call_recording_duration_seconds is null or call_recording_duration_seconds >= 0)
        and (call_recording_file_size_bytes is null or call_recording_file_size_bytes >= 0)
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_legs_state_valid') then
    alter table call_legs add constraint call_legs_state_valid
      check (state in ('created', 'started', 'answered', 'ended')) not valid;
  end if;
end
$$;

create or replace function enforce_call_state_progression()
returns trigger
language plpgsql
as $$
begin
  if new.state = old.state then
    return new;
  end if;

  if old.state in ('completed', 'failed', 'canceled') then
    raise exception 'terminal call state % cannot transition to %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.state = 'voicemail_drop_requested'
    and new.state not in (
      'bridged', 'voicemail_signal_detected', 'voicemail_playback_started',
      'agent_released', 'completed', 'failed', 'canceled'
    ) then
    raise exception 'invalid voicemail call state transition % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.state = 'voicemail_playback_started'
    and new.state not in ('agent_released', 'completed', 'failed', 'canceled') then
    raise exception 'invalid voicemail call state transition % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.state = 'agent_released'
    and new.state not in ('completed', 'failed', 'canceled') then
    raise exception 'invalid voicemail call state transition % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.state = 'voicemail_playback_completed'
    and new.state not in ('completed', 'failed') then
    raise exception 'invalid voicemail call state transition % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists calls_state_progression_guard on calls;
create trigger calls_state_progression_guard
before update of state on calls
for each row execute function enforce_call_state_progression();
