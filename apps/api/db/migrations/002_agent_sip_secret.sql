alter table agents
  add column if not exists sip_password_encrypted text;
