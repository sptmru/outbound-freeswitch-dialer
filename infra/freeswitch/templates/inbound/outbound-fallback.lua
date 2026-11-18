-- Fixed C03 operation on the retained customer. No originate or caller capture.
local api = freeswitch.API()
local uuid = session:get_uuid()
local operation, deadline, audio = argv[1], tonumber(argv[2]), argv[3]
local commandJob, commandCore = session:getVariable("outbound_dialer_command_job"), session:getVariable("outbound_dialer_command_core")
local function receipt(state)
  if not commandJob then return true end
  return api:execute("lua", freeswitch.getGlobalVariable("conf_dir") .. "/scripts/outbound-command.lua producer " .. commandCore .. " " .. commandJob .. " " .. operation .. " " .. state):match("^%+OK") ~= nil
end
if session:getVariable("outbound_dialer_ingress_durable") ~= "true" or
   not deadline or deadline <= os.time() then
  session:hangup("ALLOTTED_TIMEOUT")
  return
end
-- A duplicate transfer must never replay audio on this channel.
local key = "outbound_dialer_fallback_" .. operation
if session:getVariable(key) then return end
if not receipt("started") then session:hangup("NORMAL_TEMPORARY_FAILURE"); return end
session:setVariable(key, "started")
local function event(kind)
  session:execute("event", "Event-Name=CUSTOM,Event-Subclass=outbound_dialer::inbound_fallback_" .. kind .. ",Outbound-Dialer-Call-ID=" .. uuid .. ",Outbound-Dialer-Operation-ID=" .. operation)
end
api:execute("sched_del", uuid)
session:execute("sched_hangup", tostring(deadline) .. " ALLOTTED_TIMEOUT")
session:setVariable("playback_terminators", "none")
if not session:ready() then return end
event("started")
session:execute("playback", audio)
if not session:ready() then receipt("failed"); return end
local response = session:getVariable("current_application_response")
if response == "FILE PLAYED" then
  if not receipt("completed") then session:hangup("NORMAL_TEMPORARY_FAILURE"); return end
  session:setVariable(key, "completed")
  event("completed")
else
  if not receipt("failed") then session:hangup("NORMAL_TEMPORARY_FAILURE"); return end
  session:setVariable(key, "failed")
  event("failed")
end
-- A later committed step transfers this leg; absent workers remain bounded.
session:setVariable("park_timeout", tostring(math.max(1, deadline-os.time())))
session:execute("park")
