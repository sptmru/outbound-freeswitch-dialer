create table if not exists csv_import_failures (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references csv_imports(id) on delete cascade,
  row_number integer not null,
  reason text not null,
  row_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

delete from contacts a
using contacts b
where a.campaign_id = b.campaign_id
  and a.normalized_phone_number = b.normalized_phone_number
  and a.created_at > b.created_at;

create unique index if not exists contacts_campaign_normalized_phone_unique_idx
  on contacts(campaign_id, normalized_phone_number);

create index if not exists csv_import_failures_import_id_idx
  on csv_import_failures(import_id, row_number);
