alter table recordings
  add column if not exists file_size_bytes integer not null default 0;
