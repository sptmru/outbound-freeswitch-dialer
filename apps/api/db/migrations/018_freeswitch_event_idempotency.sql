alter table call_events
  add column if not exists freeswitch_event_uuid uuid;
