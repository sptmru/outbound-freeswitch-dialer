-- E01: actor-scoped Ignore replay survives Desk replacement and later offers.
create table call_offer_mutations (
  actor_user_id uuid not null references users(id),
  idempotency_key uuid not null,
  offer_id uuid not null references call_offers(id) on delete restrict,
  request_fingerprint text not null check(request_fingerprint ~ '^[0-9a-f]{64}$'),
  revision bigint not null check(revision>0),
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_user_id,idempotency_key)
);
-- Refresh hints flow through the existing LISTEN/live-events.ts bridge. Row
-- triggers avoid notifications from no-op polling/expiry statements; PostgreSQL
-- coalesces identical hints per transaction and delivers only after commit.
create trigger notify_call_offers_changed after insert or update or delete on call_offers
  for each row execute function notify_outbound_dialer_change();
create trigger notify_call_offer_exclusions_changed after insert or delete on call_offer_exclusions
  for each row execute function notify_outbound_dialer_change();
create trigger notify_agent_auto_next_intents_changed after insert or delete on agent_auto_next_intents
  for each row execute function notify_outbound_dialer_change();
create trigger notify_agent_auto_next_intents_updated after update on agent_auto_next_intents
  for each row when (old is distinct from new) execute function notify_outbound_dialer_change();
