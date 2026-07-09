alter table agents
  add column if not exists registered boolean not null default false;

alter table agents
  add column if not exists last_unregistered_at timestamptz;
