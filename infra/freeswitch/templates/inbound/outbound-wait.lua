-- Reached only by the C03 fixed waiting operation, after queue/capacity COMMIT.
local api = freeswitch.API()
local uuid = session:get_uuid()
local operation = argv[1]
local deadline = tonumber(argv[2])
local audio = argv[3]
local receipt = api:execute("curl", "http://127.0.0.1:18093/admission connect-timeout 1 timeout 1 post uuid=" .. uuid)
if session:getVariable("outbound_dialer_ingress_durable") ~= "true" or
   receipt ~= "admitted:" .. operation or not deadline or deadline <= os.time() then
  session:hangup("NORMAL_TEMPORARY_FAILURE")
  return
end
-- Replace the pre-admission guard with the ORIGINAL absolute queue deadline.
api:execute("sched_del", uuid)
api:execute("uuid_limit_release", uuid .. " hash outbound_dialer pre_admission")
session:setVariable("park_timeout", tostring(math.max(1, deadline - os.time())))
session:execute("sched_hangup", tostring(deadline) .. " ALLOTTED_TIMEOUT")
session:setVariable("outbound_dialer_call_id", uuid)
session:setVariable("outbound_dialer_wait_operation", operation)
if not session:ready() then return end
session:answer()
if not session:ready() then return end
session:execute("event", "Event-Name=CUSTOM,Event-Subclass=outbound_dialer::inbound_waiting_started,Outbound-Dialer-Call-ID=" .. uuid .. ",Outbound-Dialer-Operation-ID=" .. operation .. ",Outbound-Dialer-Customer-Leg-UUID=" .. uuid)
if audio == "tone" then audio = "tone_stream://%(1000,0,440)" end
session:execute("endless_playback", audio)
