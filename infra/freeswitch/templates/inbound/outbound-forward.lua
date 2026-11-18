-- One reserved external UUID. The native bridge owns cancellation on customer exit.
local api = freeswitch.API()
local uuid = session:get_uuid()
local operation, external = argv[1], argv[2]
local deadline, flowDeadline = tonumber(argv[3]), tonumber(argv[4])
local caller, dial = argv[5], argv[6]
local key = "outbound_dialer_forward_" .. operation
local commandJob, commandCore = session:getVariable("outbound_dialer_command_job"), session:getVariable("outbound_dialer_command_core")
local function receipt(state)
  if not commandJob then return true end -- Older transport remains conservative.
  return api:execute("lua", freeswitch.getGlobalVariable("conf_dir") .. "/scripts/outbound-command.lua producer " .. commandCore .. " " .. commandJob .. " " .. operation .. " " .. state):match("^%+OK") ~= nil
end
if session:getVariable(key) then return end
if not receipt("started") then session:hangup("NORMAL_TEMPORARY_FAILURE"); return end
session:setVariable(key, "started")
local function finished()
  if not receipt("finished") then return end
  -- session:execute(event) cannot emit after customer hangup; use a detached event.
  local e = freeswitch.Event("CUSTOM", "outbound_dialer::inbound_forward_finished")
  e:addHeader("Outbound-Dialer-Call-ID", uuid)
  e:addHeader("Outbound-Dialer-Operation-ID", operation)
  e:addHeader("Outbound-Dialer-External-UUID", external)
  e:fire()
end
if session:getVariable("outbound_dialer_ingress_durable") ~= "true" or
  not deadline or not flowDeadline or deadline <= os.time() or not session:ready() then
  finished()
  if session:ready() then session:hangup("ALLOTTED_TIMEOUT") end
  return
end
session:setVariable("hangup_after_bridge", "false")
session:setVariable("continue_on_fail", "true")
session:setVariable("call_timeout", tostring(math.max(1,deadline-os.time())))
-- Waiting/flow guard is canceled by the answered external leg, not submission.
local vars = "{origination_uuid=" .. external .. ",outbound_dialer_call_id=" .. uuid ..
  ",origination_caller_id_number=" .. caller .. ",origination_caller_id_name=" .. caller ..
  ",originate_timeout=" .. tostring(math.max(1,deadline-os.time())) ..
  ",ignore_early_media=true,api_on_answer='sched_del " .. uuid .. "'}"
session:execute("bridge", vars .. dial)
session:setVariable(key, "finished")
finished()
if not session:ready() then return end
if session:getVariable("originate_disposition") == "SUCCESS" then
  session:hangup("NORMAL_CLEARING")
else
  -- Failure continuation keeps the original flow bound, never a fresh deadline.
  session:setVariable("park_timeout", tostring(math.max(1,flowDeadline-os.time())))
  session:execute("park")
end
