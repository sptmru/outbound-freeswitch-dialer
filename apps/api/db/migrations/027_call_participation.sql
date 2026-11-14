-- Feature-off foundation. Legacy media tables remain writable projections for
-- single-owner outbound only; new flows use the concrete-identity tables below.
lock table calls, call_legs, call_media_stats, call_browser_media_stats in share row exclusive mode;

alter table inbound_queues add constraint inbound_queues_id_campaign_unique unique(id,campaign_id);
alter table calls
  add column direction text not null default 'outbound' check(direction in ('outbound','inbound')),
  add column original_did text,
  add column calling_number text,
  add column called_number text,
  add column inbound_queue_id uuid,
  add column arrived_at timestamptz,
  add column queue_deadline_at timestamptz,
  add column queue_exited_at timestamptz,
  add column pstn_answered_at timestamptz,
  add column agent_connected_at timestamptz,
  add column fallback_started_at timestamptz,
  add constraint calls_queue_campaign_fk foreign key(inbound_queue_id,campaign_id)
    references inbound_queues(id,campaign_id),
  add constraint calls_inbound_identity_check check(direction <> 'inbound' or
    (campaign_id is not null and inbound_queue_id is not null and original_did is not null
      and calling_number is not null and called_number is not null and arrived_at is not null
      and queue_deadline_at is not null)),
  add constraint calls_inbound_time_check check(
    (queue_deadline_at is null or queue_deadline_at > arrived_at)
    and (pstn_answered_at is null or pstn_answered_at >= arrived_at)
    and (agent_connected_at is null or agent_connected_at >= arrived_at)
    and (queue_exited_at is null or queue_exited_at >= arrived_at)
    and (fallback_started_at is null or fallback_started_at >= arrived_at)
    and (agent_connected_at is null or pstn_answered_at is null or agent_connected_at >= pstn_answered_at));

-- Legacy answered_at also advances on customer CHANNEL_ANSWER: it is not proof
-- of a browser bridge. Retain it exactly; never fabricate agent_connected_at.
update calls set calling_number=caller_id,called_number=normalized_destination_number,
  pstn_answered_at=answered_at;

-- 012 checked pg_constraint by name across all schemas; disposable schema
-- fixtures can therefore lack this constraint when another schema has it.
-- Re-establish our own constraint without editing the applied migration.
alter table calls drop constraint if exists calls_state_valid;
alter table calls add constraint calls_state_valid check(state in (
  'created','agent_ringing','agent_answered','customer_dialing','customer_ringing',
  'bridged','voicemail_signal_detected','voicemail_drop_requested','voicemail_playback_started',
  'agent_released','voicemail_playback_completed','completed','failed','canceled',
  'received','queued','connecting','agent_connected','fallback','audio_playing','forwarding'
)) not valid;
create index calls_inbound_queue_arrival_idx on calls(inbound_queue_id,arrived_at,id)
  where direction='inbound' and ended_at is null;

create function preserve_call_origin() returns trigger language plpgsql as $$
begin
  if row(new.direction,new.campaign_id,new.original_did,new.inbound_queue_id,new.arrived_at,
         new.calling_number,new.called_number)
    is distinct from row(old.direction,old.campaign_id,old.original_did,old.inbound_queue_id,old.arrived_at,
         old.calling_number,old.called_number) then
    raise exception 'Call origin and campaign are immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger calls_preserve_origin before update on calls
  for each row execute function preserve_call_origin();

create table call_participants (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  role text not null check(role in ('agent','customer','external')),
  agent_id uuid references agents(id),
  external_number text,
  joined_at timestamptz,
  connected_at timestamptz,
  left_at timestamptz,
  end_reason text,
  origin text not null default 'native' check(origin in ('native','legacy_backfill')),
  created_at timestamptz not null default now(),
  unique(id,call_id),
  unique(id,call_id,agent_id),
  check((role='agent') = (agent_id is not null)),
  check(connected_at is null or joined_at is null or connected_at >= joined_at),
  check(left_at is null or joined_at is null or left_at >= joined_at),
  check(left_at is null or connected_at is null or left_at >= connected_at)
);
create index call_participants_call_idx on call_participants(call_id,joined_at,id);
create index call_participants_agent_idx on call_participants(agent_id,call_id) where agent_id is not null;

alter table call_legs drop constraint call_legs_type_check;
alter table call_legs add constraint call_legs_type_check check(type in ('agent','customer','external'));
alter table call_legs add column participant_id uuid,
  add constraint call_legs_participant_fk foreign key(participant_id,call_id)
    references call_participants(id,call_id) on delete cascade;
create unique index call_legs_participant_idx on call_legs(participant_id) where participant_id is not null;

-- One participation per evidenced legacy leg; no fictitious interval or bridge.
-- Ownerless legacy agent legs remain unlinked, with their original evidence intact.
insert into call_participants(id,call_id,role,agent_id,external_number,joined_at,left_at,origin)
select l.id,l.call_id,l.type,case when l.type='agent' then c.agent_id end,
  case when l.type='customer' then c.normalized_destination_number end,
  l.started_at,case when l.ended_at >= l.started_at or l.started_at is null then l.ended_at end,'legacy_backfill'
from call_legs l join calls c on c.id=l.call_id
where l.type='customer' or c.agent_id is not null;
update call_legs l set participant_id=p.id from call_participants p where p.id=l.id;

create function preserve_call_participant_identity() returns trigger language plpgsql as $$
begin
  if row(new.id,new.call_id,new.role,new.agent_id,new.external_number,new.origin)
    is distinct from row(old.id,old.call_id,old.role,old.agent_id,old.external_number,old.origin) then
    raise exception 'Participant identity is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger call_participants_preserve_identity before update on call_participants
  for each row execute function preserve_call_participant_identity();

create function validate_call_leg_participant() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and
    (row(new.id,new.call_id,new.type) is distinct from row(old.id,old.call_id,old.type)
      or (old.participant_id is not null and new.participant_id is distinct from old.participant_id)
      or (old.freeswitch_uuid is not null and new.freeswitch_uuid is distinct from old.freeswitch_uuid)) then
    raise exception 'Concrete leg identity is immutable' using errcode='23514';
  end if;
  if new.participant_id is not null and not exists(select 1 from call_participants p
    where p.id=new.participant_id and p.call_id=new.call_id and p.role=new.type) then
    raise exception 'Leg must match its participation' using errcode='23503';
  end if;
  return new;
end $$;
create trigger call_legs_participant_guard before insert or update on call_legs
  for each row execute function validate_call_leg_participant();

alter table agent_call_slots add constraint agent_call_slots_participant_fk
  foreign key(participant_id,call_id,agent_id) references call_participants(id,call_id,agent_id);

-- Keep all bounded typed metrics, but key by concrete identity instead of role/call.
-- LIKE deliberately excludes legacy PK/indexes and does not copy foreign keys.
create table call_leg_media_stats (like call_media_stats including defaults including constraints,
  call_leg_id uuid primary key,
  foreign key(call_leg_id,call_id) references call_legs(id,call_id) on delete cascade);
alter table call_leg_media_stats drop constraint call_media_stats_leg_type_check;
alter table call_leg_media_stats add check(leg_type in ('agent','customer','external'));
create index call_leg_media_stats_call_idx on call_leg_media_stats(call_id);

create table call_participant_browser_media_stats (
  like call_browser_media_stats including defaults including constraints,
  participant_id uuid primary key,
  foreign key(participant_id,call_id) references call_participants(id,call_id) on delete cascade);
create index call_participant_browser_stats_call_idx on call_participant_browser_media_stats(call_id);

create function validate_concrete_media_identity() returns trigger language plpgsql as $$
begin
  if tg_table_name='call_leg_media_stats' then
    if not exists(select 1 from call_legs l where l.id=new.call_leg_id and l.call_id=new.call_id
      and l.type=new.leg_type and l.freeswitch_uuid is not distinct from new.freeswitch_uuid) then
      raise exception 'Media must match concrete leg' using errcode='23503';
    end if;
  else
    if not exists(select 1 from call_participants p where p.id=new.participant_id and p.call_id=new.call_id
      and p.role='agent') then
      raise exception 'Browser media must match agent participation' using errcode='23503';
    end if;
  end if;
  return new;
end $$;
create trigger call_leg_media_identity before insert or update on call_leg_media_stats
  for each row execute function validate_concrete_media_identity();
create trigger call_participant_browser_media_identity before insert or update on call_participant_browser_media_stats
  for each row execute function validate_concrete_media_identity();

insert into call_leg_media_stats
select (jsonb_populate_record(null::call_leg_media_stats,
  to_jsonb(s)||jsonb_build_object('call_leg_id',l.id))).*
from call_media_stats s join call_legs l on l.call_id=s.call_id and l.type=s.leg_type
  and l.freeswitch_uuid=s.freeswitch_uuid;

-- A legacy browser summary has no leg identity. Link only an unambiguous single
-- agent participation; ambiguous/unmatched evidence stays in its original table.
insert into call_participant_browser_media_stats
select (jsonb_populate_record(null::call_participant_browser_media_stats,
  to_jsonb(s)||jsonb_build_object('participant_id',p.id))).*
from call_browser_media_stats s join call_participants p on p.call_id=s.call_id and p.role='agent'
where (select count(*) from call_participants q where q.call_id=s.call_id and q.role='agent')=1;
