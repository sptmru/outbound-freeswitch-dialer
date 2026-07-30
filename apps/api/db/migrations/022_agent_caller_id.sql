alter table agents
  add column if not exists caller_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_caller_id_valid') then
    alter table agents add constraint agents_caller_id_valid
      check (
        caller_id is null
        or (caller_id = btrim(caller_id) and char_length(caller_id) between 1 and 80)
      ) not valid;
  end if;
end $$;
