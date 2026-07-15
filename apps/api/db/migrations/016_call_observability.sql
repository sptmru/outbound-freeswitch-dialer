alter table calls
  add column if not exists freeswitch_terminal_at timestamptz;

alter table calls
  add column if not exists terminal_persisted_at timestamptz;

alter table calls
  add column if not exists terminal_source text;

alter table calls
  add column if not exists terminal_event_name text;

alter table calls
  add column if not exists finalization_latency_ms integer;

alter table calls
  drop constraint if exists calls_finalization_latency_ms_check;

alter table calls
  add constraint calls_finalization_latency_ms_check
  check (finalization_latency_ms is null or finalization_latency_ms >= 0);

create table if not exists call_media_stats (
  call_id uuid not null references calls(id) on delete cascade,
  leg_type text not null check (leg_type in ('agent', 'customer')),
  freeswitch_uuid text,
  source_event_name text not null,
  captured_at timestamptz not null,
  read_codec text,
  write_codec text,
  sip_gateway text,
  sip_profile text,
  codec_rate integer,
  codec_ptime integer,
  inbound_packet_count bigint,
  outbound_packet_count bigint,
  inbound_media_packet_count bigint,
  outbound_media_packet_count bigint,
  inbound_media_bytes bigint,
  outbound_media_bytes bigint,
  inbound_skip_packet_count bigint,
  outbound_skip_packet_count bigint,
  inbound_flaw_total bigint,
  inbound_jitter_packet_count bigint,
  inbound_jitter_loss_rate double precision,
  inbound_jitter_burst_rate double precision,
  inbound_jitter_max_variance double precision,
  inbound_mos double precision,
  inbound_quality_percentage double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (call_id, leg_type)
);

create index if not exists call_media_stats_captured_at_idx
  on call_media_stats(captured_at desc);

insert into call_media_stats (
  call_id,
  leg_type,
  freeswitch_uuid,
  source_event_name,
  captured_at,
  read_codec,
  write_codec,
  sip_gateway,
  sip_profile,
  codec_rate,
  codec_ptime,
  inbound_packet_count,
  outbound_packet_count,
  inbound_media_packet_count,
  outbound_media_packet_count,
  inbound_media_bytes,
  outbound_media_bytes,
  inbound_skip_packet_count,
  outbound_skip_packet_count,
  inbound_flaw_total,
  inbound_jitter_packet_count,
  inbound_jitter_loss_rate,
  inbound_jitter_burst_rate,
  inbound_jitter_max_variance,
  inbound_mos,
  inbound_quality_percentage
)
select
  source.call_id,
  source.leg_type,
  source.freeswitch_uuid,
  'CHANNEL_HANGUP_COMPLETE',
  case
    when source.headers->>'event-date-timestamp' ~ '^\d+$'
      then to_timestamp((source.headers->>'event-date-timestamp')::numeric / 1000000)
    else source.created_at
  end,
  coalesce(source.headers->>'channel-read-codec-name', source.headers->>'variable_read_codec'),
  coalesce(source.headers->>'channel-write-codec-name', source.headers->>'variable_write_codec'),
  source.headers->>'variable_sip_gateway_name',
  coalesce(source.headers->>'variable_sip_profile_name', source.headers->>'variable_sofia_profile_name'),
  case when coalesce(source.headers->>'variable_rtp_use_codec_rate', source.headers->>'channel-read-codec-rate') ~ '^\d+$'
    then coalesce(source.headers->>'variable_rtp_use_codec_rate', source.headers->>'channel-read-codec-rate')::integer end,
  case when source.headers->>'variable_rtp_use_codec_ptime' ~ '^\d+$'
    then (source.headers->>'variable_rtp_use_codec_ptime')::integer end,
  case when source.headers->>'variable_rtp_audio_in_packet_count' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_in_packet_count')::bigint end,
  case when source.headers->>'variable_rtp_audio_out_packet_count' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_out_packet_count')::bigint end,
  case when source.headers->>'variable_rtp_audio_in_media_packet_count' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_in_media_packet_count')::bigint end,
  case when source.headers->>'variable_rtp_audio_out_media_packet_count' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_out_media_packet_count')::bigint end,
  case when source.headers->>'variable_rtp_audio_in_media_bytes' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_in_media_bytes')::bigint end,
  case when source.headers->>'variable_rtp_audio_out_media_bytes' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_out_media_bytes')::bigint end,
  case when source.headers->>'variable_rtp_audio_in_skip_packet_count' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_in_skip_packet_count')::bigint end,
  case when source.headers->>'variable_rtp_audio_out_skip_packet_count' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_out_skip_packet_count')::bigint end,
  case when source.headers->>'variable_rtp_audio_in_flaw_total' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_in_flaw_total')::bigint end,
  case when source.headers->>'variable_rtp_audio_in_jitter_packet_count' ~ '^\d+$'
    then (source.headers->>'variable_rtp_audio_in_jitter_packet_count')::bigint end,
  case when source.headers->>'variable_rtp_audio_in_jitter_loss_rate' ~ '^-?\d+(\.\d+)?$'
    then (source.headers->>'variable_rtp_audio_in_jitter_loss_rate')::double precision end,
  case when source.headers->>'variable_rtp_audio_in_jitter_burst_rate' ~ '^-?\d+(\.\d+)?$'
    then (source.headers->>'variable_rtp_audio_in_jitter_burst_rate')::double precision end,
  case when source.headers->>'variable_rtp_audio_in_jitter_max_variance' ~ '^-?\d+(\.\d+)?$'
    then (source.headers->>'variable_rtp_audio_in_jitter_max_variance')::double precision end,
  case when source.headers->>'variable_rtp_audio_in_mos' ~ '^-?\d+(\.\d+)?$'
    then (source.headers->>'variable_rtp_audio_in_mos')::double precision end,
  case when source.headers->>'variable_rtp_audio_in_quality_percentage' ~ '^-?\d+(\.\d+)?$'
    then (source.headers->>'variable_rtp_audio_in_quality_percentage')::double precision end
from (
  select distinct on (call_id, leg_type)
    call_id,
    leg_type,
    coalesce(agent_leg_uuid, customer_leg_uuid) as freeswitch_uuid,
    raw_json->'headers' as headers,
    created_at
  from (
    select
      call_events.*,
      case
        when agent_leg_uuid is not null then 'agent'
        when customer_leg_uuid is not null then 'customer'
        else raw_json->'headers'->>'variable_outbound_dialer_leg_type'
      end as leg_type
    from call_events
    where freeswitch_event_name = 'CHANNEL_HANGUP_COMPLETE'
      and raw_json ? 'headers'
  ) media_events
  where leg_type in ('agent', 'customer')
  order by call_id, leg_type, created_at desc
) source
where source.headers->>'variable_rtp_audio_in_packet_count' ~ '^\d+$'
   or source.headers->>'variable_rtp_audio_out_packet_count' ~ '^\d+$'
on conflict (call_id, leg_type) do nothing;

with first_customer_terminal as (
  select distinct on (call_id)
    call_id,
    freeswitch_event_name,
    to_timestamp((raw_json->'headers'->>'event-date-timestamp')::numeric / 1000000) as terminal_at
  from call_events
  where customer_leg_uuid is not null
    and freeswitch_event_name in ('CHANNEL_HANGUP', 'CHANNEL_HANGUP_COMPLETE', 'CHANNEL_DESTROY')
    and raw_json->'headers'->>'event-date-timestamp' ~ '^\d+$'
  order by call_id, created_at asc
)
update calls
set freeswitch_terminal_at = first_customer_terminal.terminal_at,
    terminal_persisted_at = calls.ended_at,
    terminal_source = 'freeswitch_customer_terminal',
    terminal_event_name = first_customer_terminal.freeswitch_event_name,
    finalization_latency_ms = case
      when calls.ended_at >= first_customer_terminal.terminal_at
        and floor(extract(epoch from (calls.ended_at - first_customer_terminal.terminal_at)) * 1000) <= 2147483647
      then floor(extract(epoch from (calls.ended_at - first_customer_terminal.terminal_at)) * 1000)::integer
      else null
    end
from first_customer_terminal
where calls.id = first_customer_terminal.call_id
  and calls.ended_at is not null
  and calls.freeswitch_terminal_at is null;

create table if not exists call_avmd_reviews (
  call_id uuid primary key references calls(id) on delete cascade,
  actual_party text not null check (actual_party in ('human', 'machine', 'uncertain')),
  notes text,
  reviewed_by_user_id uuid references users(id) on delete set null,
  reviewed_by_name text not null,
  reviewed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (notes is null or char_length(notes) <= 1000)
);

create index if not exists call_avmd_reviews_reviewed_at_idx
  on call_avmd_reviews(reviewed_at desc);

create table if not exists telephony_observability_state (
  singleton boolean primary key default true check (singleton),
  registration_db_count integer,
  registration_freeswitch_count integer,
  registration_drift_count integer,
  registration_corrections_last_run integer,
  registration_reconcile_status text,
  registration_reconciled_at timestamptz,
  active_calls_db_count integer,
  active_calls_missing_in_freeswitch integer,
  active_calls_closed_last_run integer,
  active_call_reconcile_status text,
  active_calls_reconciled_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into telephony_observability_state (singleton)
values (true)
on conflict (singleton) do nothing;
