-- Agents created after a completed cutover have no legacy ownership to reconcile.
-- Serialize this decision with the offline cutover's lock on agents.
create or replace function initialize_agent_call_slot() returns trigger language plpgsql as $$
begin
  if exists (select 1 from call_admission_migration where not reconciliation_required and reconciled_at is not null) then
    insert into agent_call_slots(agent_id,state,reservation_id,reconciliation_required)
    values (new.id,'free',null,false);
  else
    insert into agent_call_slots(agent_id) values (new.id);
  end if;
  return new;
end $$;
