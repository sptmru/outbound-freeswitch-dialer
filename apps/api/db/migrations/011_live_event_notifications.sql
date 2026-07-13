create or replace function notify_outbound_dialer_change()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify('outbound_dialer_changes', TG_TABLE_NAME);
  return null;
end;
$$;

do $$
declare
  table_name text;
  trigger_name text;
begin
  foreach table_name in array array[
    'agents',
    'calls',
    'call_events',
    'campaigns',
    'contacts',
    'recordings',
    'suppression_entries',
    'suppression_events',
    'users'
  ] loop
    trigger_name := 'notify_' || table_name || '_changed';
    execute format('drop trigger if exists %I on %I', trigger_name, table_name);
    execute format(
      'create trigger %I after insert or update or delete on %I for each statement execute function notify_outbound_dialer_change()',
      trigger_name,
      table_name
    );
  end loop;
end;
$$;
