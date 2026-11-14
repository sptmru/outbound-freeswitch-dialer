-- Additive configuration only: no route is seeded or enabled, no call state changes.
create table inbound_flows (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (id, campaign_id)
);

-- Actions are deliberately finite: no nested flow, jumps, retries or recursive overflow.
create function inbound_flow_actions_valid(actions jsonb, budget integer) returns boolean
language plpgsql immutable strict as $$
declare
  action jsonb;
  kind text;
  duration numeric;
  total numeric := 0;
  plays integer := 0;
  forwards integer := 0;
  position integer := 0;
begin
  if jsonb_typeof(actions) <> 'array' then return false; end if;
  if jsonb_array_length(actions) not between 1 and 3 then return false; end if;
  for action in select value from jsonb_array_elements(actions) loop
    position := position + 1;
    if jsonb_typeof(action) <> 'object' then return false; end if;
    kind := action->>'type';
    if kind = 'hangup' then
      if action <> '{"type":"hangup"}'::jsonb or position <> jsonb_array_length(actions) then return false; end if;
    elsif kind in ('play_audio', 'forward_external') then
      if jsonb_typeof(action->'timeoutMs') is distinct from 'number' then return false; end if;
      duration := (action->>'timeoutMs')::numeric;
      if duration <> trunc(duration) then return false; end if;
      total := total + duration;
      if kind = 'play_audio' then
        plays := plays + 1;
        if duration not between 1000 and 60000 or
          jsonb_typeof(action->'recordingId') is distinct from 'string' or
          (action->>'recordingId') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' or
          action - array['type','recordingId','timeoutMs'] <> '{}'::jsonb then return false; end if;
      else
        forwards := forwards + 1;
        if duration not between 5000 and 30000 or
          jsonb_typeof(action->'target') is distinct from 'string' or
          (action->>'target') !~ '^\+[1-9][0-9]{6,14}$' or
          action - array['type','target','timeoutMs'] <> '{}'::jsonb then return false; end if;
      end if;
    else return false;
    end if;
  end loop;
  return plays <= 2 and forwards <= 1 and total <= budget;
end;
$$;

create function inbound_flow_audio(actions jsonb, ordinal integer) returns uuid
language sql immutable strict as $$
  select (value->>'recordingId')::uuid from jsonb_array_elements(actions)
  where value->>'type' = 'play_audio' offset ordinal limit 1
$$;

create table inbound_flow_versions (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null,
  campaign_id uuid not null,
  version integer not null check (version > 0),
  flow_timeout_ms integer not null default 90000 check (flow_timeout_ms between 1000 and 180000),
  actions jsonb not null check (inbound_flow_actions_valid(actions, flow_timeout_ms)),
  first_audio_id uuid generated always as (inbound_flow_audio(actions, 0)) stored,
  second_audio_id uuid generated always as (inbound_flow_audio(actions, 1)) stored,
  audio_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (flow_id, version),
  unique (id, campaign_id),
  foreign key (flow_id, campaign_id) references inbound_flows(id, campaign_id),
  foreign key (first_audio_id, campaign_id) references recordings(id, campaign_id),
  foreign key (second_audio_id, campaign_id) references recordings(id, campaign_id)
);

create function inbound_flow_version_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Saved inbound flow versions are immutable; insert a new version' using errcode = '23514';
end;
$$;
create trigger inbound_flow_version_immutable before update or delete on inbound_flow_versions
for each row execute function inbound_flow_version_immutable();

-- Snapshot media parameters under row locks as part of saving a version. Future edits
-- to the media library cannot change the parameters retained by an executing call.
create function inbound_flow_snapshot_audio() returns trigger language plpgsql as $$
declare
  audio_ids uuid[];
begin
  if not inbound_flow_actions_valid(new.actions, new.flow_timeout_ms) then
    raise exception 'Invalid bounded inbound flow' using errcode = '23514';
  end if;
  audio_ids := array[inbound_flow_audio(new.actions, 0), inbound_flow_audio(new.actions, 1)];
  perform id from recordings where id = any(audio_ids) order by id for share;
  if exists (select 1 from unnest(audio_ids) as wanted(id) where id is not null and not exists
    (select 1 from recordings where recordings.id = wanted.id and campaign_id = new.campaign_id and is_active)) then
    raise exception 'Inbound audio must be active and owned by the flow campaign' using errcode = '23503';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('recordingId', id, 'filePath', file_path,
    'runtimeFilePath', runtime_file_path, 'durationSeconds', duration_seconds) order by id), '[]'::jsonb)
    into new.audio_snapshot from recordings where id = any(audio_ids);
  return new;
end;
$$;
create trigger inbound_flow_snapshot_audio before insert on inbound_flow_versions
for each row execute function inbound_flow_snapshot_audio();
create index inbound_flow_versions_first_audio_idx on inbound_flow_versions(first_audio_id) where first_audio_id is not null;
create index inbound_flow_versions_second_audio_idx on inbound_flow_versions(second_audio_id) where second_audio_id is not null;

create table inbound_queues (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  waiting_audio_id uuid,
  no_answer_flow_version_id uuid,
  offer_timeout_ms integer not null default 15000 check (offer_timeout_ms between 5000 and 30000),
  queue_timeout_ms integer not null default 60000 check (queue_timeout_ms between 15000 and 300000),
  connect_timeout_ms integer not null default 10000 check (connect_timeout_ms between 6000 and 15000),
  transfer_timeout_ms integer not null default 20000 check (transfer_timeout_ms between 5000 and 30000),
  max_waiting_calls integer not null default 40 check (max_waiting_calls between 1 and 200),
  overflow_policy text not null default 'reject' check (overflow_policy in ('reject', 'flow')),
  overflow_flow_version_id uuid,
  desired_revision bigint not null default 1 check (desired_revision > 0),
  applied_revision bigint check (applied_revision > 0 and applied_revision <= desired_revision),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (connect_timeout_ms < queue_timeout_ms),
  check ((overflow_policy = 'flow') = (overflow_flow_version_id is not null)),
  foreign key (waiting_audio_id, campaign_id) references recordings(id, campaign_id),
  foreign key (no_answer_flow_version_id, campaign_id) references inbound_flow_versions(id, campaign_id),
  foreign key (overflow_flow_version_id, campaign_id) references inbound_flow_versions(id, campaign_id)
);
create index inbound_queues_campaign_idx on inbound_queues(campaign_id);

create table inbound_numbers (
  id uuid primary key default gen_random_uuid(),
  normalized_did text not null unique check (normalized_did ~ '^\+[1-9][0-9]{6,14}$'),
  label text not null check (length(btrim(label)) between 1 and 200),
  queue_id uuid not null references inbound_queues(id),
  enabled boolean not null default false,
  desired_revision bigint not null default 1 check (desired_revision > 0),
  applied_revision bigint check (applied_revision > 0 and applied_revision <= desired_revision),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inbound_numbers_queue_idx on inbound_numbers(queue_id);

-- A saved edit invalidates the previous applied revision; only D02 can confirm FS application.
create function inbound_configuration_revision() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - array['desired_revision','applied_revision','updated_at'])
    is distinct from (to_jsonb(old) - array['desired_revision','applied_revision','updated_at']) then
    new.desired_revision := old.desired_revision + 1;
    new.applied_revision := old.applied_revision;
  else
    new.desired_revision := old.desired_revision;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger inbound_queue_revision before update on inbound_queues
for each row execute function inbound_configuration_revision();
create trigger inbound_number_revision before update on inbound_numbers
for each row execute function inbound_configuration_revision();
