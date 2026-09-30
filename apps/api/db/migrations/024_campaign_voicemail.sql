-- Legacy, unassigned assets remain for historical references only.
alter table recordings add column campaign_id uuid references campaigns(id);
alter table recordings add constraint recordings_id_campaign_unique unique (id, campaign_id);
create index recordings_campaign_idx on recordings(campaign_id) where campaign_id is not null;
alter table campaigns add column voicemail_recording_id uuid;
alter table campaigns add constraint campaigns_voicemail_ownership
  foreign key (voicemail_recording_id, id) references recordings(id, campaign_id);
