alter table recordings
  add column if not exists duration_seconds integer not null default 0;
