-- Bound scrape snapshot reads to active work and the recent outcome window.
create index calls_inbound_metrics_queue_idx on calls (state, arrived_at)
  where direction='inbound' and ended_at is null and queue_exited_at is null;
create index calls_inbound_metrics_exit_idx on calls (queue_exited_at)
  where direction='inbound' and queue_exited_at is not null;
create index call_offers_metrics_closed_idx on call_offers (closed_at) where closed_at is not null;
create index inbound_connection_metrics_settled_idx on inbound_connection_attempts (settled_at) where settled_at is not null;
create index call_transfers_metrics_closed_idx on call_transfers (closed_at) where closed_at is not null;
create index call_operations_metrics_fallback_idx on call_operations (resolved_at)
  where resolved_at is not null and request->>'inboundFallback'='true';
