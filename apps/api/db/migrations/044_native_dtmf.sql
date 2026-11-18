-- Additive command vocabulary; older workers must not consume native controls.
alter table call_operations drop constraint call_operations_command_kind_check;
alter table call_operations add constraint call_operations_command_kind_check check(command_kind in
  ('originate','bridge','rebridge','play_audio','hangup','release_agent','forward_external','send_dtmf'));
