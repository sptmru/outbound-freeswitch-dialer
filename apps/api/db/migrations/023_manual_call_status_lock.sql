alter table calls
  add column if not exists manual_status_locked_at timestamptz;

alter table calls
  add column if not exists manual_status_locked_by_user_id uuid references users(id) on delete set null;

alter table calls
  drop constraint if exists calls_manual_status_lock_valid;

alter table calls
  add constraint calls_manual_status_lock_valid
  check (
    manual_status_locked_at is null
    or (
      state in ('completed', 'failed', 'canceled')
      and outcome is not null
    )
  );

create or replace function enforce_call_state_progression()
returns trigger
language plpgsql
as $$
begin
  -- A manual API status is immutable. Late/replayed ESL events may still update
  -- diagnostic columns, but they cannot replace the manually selected result.
  if old.manual_status_locked_at is not null then
    new.state := old.state;
    new.outcome := old.outcome;
    new.manual_status_locked_at := old.manual_status_locked_at;
    new.manual_status_locked_by_user_id := old.manual_status_locked_by_user_id;
    return new;
  end if;

  -- The manual status endpoint is allowed to correct an already-terminal call.
  -- Its single UPDATE sets the terminal state, outcome, and lock atomically.
  if new.manual_status_locked_at is not null then
    if new.state not in ('completed', 'failed', 'canceled') or new.outcome is null then
      raise exception 'manual call status must be terminal and have an outcome'
        using errcode = '23514';
    end if;
    return new;
  end if;

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
before update of state, outcome, manual_status_locked_at, manual_status_locked_by_user_id on calls
for each row execute function enforce_call_state_progression();
