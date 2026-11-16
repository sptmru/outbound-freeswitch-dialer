-- F02: a previously published route may still be captured/imported after an edit.
-- Pin its waiting asset until H04 establishes an explicitly drained retention rule.
alter table inbound_ingress_route_snapshots add column waiting_audio_id uuid
  generated always as ((snapshot #>> '{queue_snapshot,waiting_audio_id}')::uuid) stored,
  add foreign key (waiting_audio_id,campaign_id) references recordings(id,campaign_id);
create index inbound_ingress_route_audio_idx on inbound_ingress_route_snapshots(waiting_audio_id)
  where waiting_audio_id is not null;

create function pin_published_waiting_audio() returns trigger language plpgsql as $$
declare audio_id uuid := (new.snapshot #>> '{queue_snapshot,waiting_audio_id}')::uuid;
begin
  if audio_id is not null then
    perform id from recordings where id=audio_id and campaign_id=new.campaign_id and is_active for share;
    if not found then
      raise exception 'Published waiting audio must be active and campaign-owned' using errcode='23503';
    end if;
  end if;
  return new;
end $$;
create trigger pin_published_waiting_audio before insert on inbound_ingress_route_snapshots
  for each row execute function pin_published_waiting_audio();

-- The immediately previous API does not know this reference class. Fail its
-- soft-delete transaction before it can authorize filesystem unlink.
create function retain_published_waiting_audio() returns trigger language plpgsql as $$
begin
  if old.is_active and not new.is_active and exists (
    select 1 from inbound_ingress_route_snapshots where waiting_audio_id=old.id
  ) then
    raise exception 'Published waiting audio requires explicit drained retention' using errcode='23503';
  end if;
  return new;
end $$;
create trigger retain_published_waiting_audio before update of is_active on recordings
  for each row execute function retain_published_waiting_audio();
