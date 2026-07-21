alter table campaigns
  add column if not exists auto_advance_to_next_lead_enabled boolean not null default false;
