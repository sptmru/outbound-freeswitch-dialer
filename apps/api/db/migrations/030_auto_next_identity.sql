-- Nullable for existing B04 rows and the immediately previous binary. New C05
-- writers require both values; unknown old pending identity fails closed.
alter table agent_auto_next_intents
  add column request_fingerprint text check(request_fingerprint ~ '^[0-9a-f]{64}$'),
  add column binding_generation bigint check(binding_generation > 0);
