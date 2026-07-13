create table call_pcaps (
  call_id uuid primary key references calls(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'capturing', 'available', 'failed', 'expired')),
  file_path text,
  file_size_bytes bigint,
  started_at timestamptz,
  ended_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index call_pcaps_status_idx on call_pcaps (status, updated_at);

drop trigger if exists notify_call_pcaps_changed on call_pcaps;
create trigger notify_call_pcaps_changed
after insert or update or delete on call_pcaps
for each row execute function notify_outbound_dialer_change();
