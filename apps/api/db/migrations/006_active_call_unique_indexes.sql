create unique index if not exists calls_one_active_per_agent_idx
  on calls(agent_id)
  where agent_id is not null
    and ended_at is null
    and state not in ('completed', 'failed', 'canceled');

create unique index if not exists calls_one_active_per_contact_idx
  on calls(contact_id)
  where contact_id is not null
    and ended_at is null
    and state not in ('completed', 'failed', 'canceled');
