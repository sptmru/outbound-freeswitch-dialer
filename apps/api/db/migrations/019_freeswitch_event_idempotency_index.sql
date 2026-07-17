-- outbound-dialer:no-transaction
-- Historical rows intentionally remain NULL. New event persistence establishes
-- the durable replay key without rewriting or deleting a large live event table.
-- Remove an invalid remnant left by an interrupted concurrent build. This file
-- is unrecorded until both idempotent statements have succeeded.
drop index concurrently if exists call_events_freeswitch_event_uuid_unique_idx;
-- outbound-dialer:statement
create unique index concurrently if not exists call_events_freeswitch_event_uuid_unique_idx
  on call_events(freeswitch_event_uuid)
  where freeswitch_event_uuid is not null;
