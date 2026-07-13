alter table agents
  add column if not exists availability_status text not null default 'available',
  add column if not exists wrap_up_until timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_availability_status_valid') then
    alter table agents add constraint agents_availability_status_valid
      check (availability_status in ('available', 'paused', 'wrap_up')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_wrap_up_until_consistent') then
    alter table agents add constraint agents_wrap_up_until_consistent
      check (
        (availability_status = 'wrap_up' and wrap_up_until is not null)
        or (availability_status <> 'wrap_up' and wrap_up_until is null)
      ) not valid;
  end if;
end $$;

create index if not exists agents_wrap_up_until_idx
  on agents(wrap_up_until)
  where availability_status = 'wrap_up';
