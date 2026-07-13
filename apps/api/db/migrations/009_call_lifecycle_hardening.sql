alter table calls
  add column if not exists voicemail_drop_requested_at timestamptz;

alter table calls
  add column if not exists voicemail_playback_started_at timestamptz;

alter table calls
  add column if not exists agent_released_at timestamptz;

alter table calls
  add column if not exists voicemail_playback_completed_at timestamptz;

alter table contacts
  add column if not exists attempt_count integer not null default 0;

alter table contacts
  add column if not exists last_attempted_at timestamptz;

delete from call_events newer
using call_events older
where newer.call_id = older.call_id
  and newer.event_type = older.event_type
  and newer.event_type in (
    'voicemail_drop_requested',
    'voicemail_playback_started',
    'agent_released',
    'voicemail_playback_completed',
    'voicemail_playback_interrupted'
  )
  and (
    newer.created_at > older.created_at
    or (newer.created_at = older.created_at and newer.id > older.id)
  );

create unique index if not exists call_events_one_voicemail_lifecycle_event_idx
  on call_events(call_id, event_type)
  where event_type in (
    'voicemail_drop_requested',
    'voicemail_playback_started',
    'agent_released',
    'voicemail_playback_completed',
    'voicemail_playback_interrupted'
  );

drop index if exists calls_one_active_per_agent_idx;

create unique index calls_one_active_per_agent_idx
  on calls(agent_id)
  where agent_id is not null
    and ended_at is null
    and state not in ('completed', 'failed', 'canceled', 'agent_released');
