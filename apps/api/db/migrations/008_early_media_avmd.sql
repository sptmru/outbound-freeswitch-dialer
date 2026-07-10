alter table campaigns
  add column if not exists early_media_avmd_enabled boolean not null default false;

alter table calls
  add column if not exists early_media_avmd_enabled boolean not null default false;
