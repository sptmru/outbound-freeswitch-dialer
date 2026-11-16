-- D03 capture receipt is storage evidence, never permission to answer or play audio.
if os.getenv("FREESWITCH_INGRESS_ENABLED") ~= "true" then return end
local api = freeswitch.API()
local uuid = session:get_uuid()
local function post(path)
  return api:execute("curl", "http://127.0.0.1:18093/" .. path ..
    " connect-timeout 1 timeout 1 post uuid=" .. uuid)
end
-- The separate agent validates internal tags/arrival using its own fresh ESL read.
-- Never send credentials through mod_curl (it logs headers and bodies at DEBUG).
local receipt = post("capture")
if receipt ~= "stored:" .. uuid then
  freeswitch.consoleLog("ERR", "D03 ingress capture unavailable; refusing before answer\n")
  return
end
session:setVariable("outbound_dialer_ingress_durable", "true")
function outbound_ingress_ended(s)
  local result = post("terminal")
  if result ~= "stored:" .. uuid then
    freeswitch.consoleLog("ERR", "D03 terminal capture pending; retain journal for discovery\n")
  end
end
session:setHangupHook("outbound_ingress_ended")
-- D04 must add the bounded DB admission/ack continuation here. Until then the
-- generated dialplan refuses. Native pre-admission/trunk guards remain held.
-- Bounded pre-admission waiting only, without SIP answer or media. D04 owns
-- replacing "pending" with a receipt tied to its committed queue/capacity claim.
for attempt = 1, 10 do
  if not session:ready() then return end
  if post("admission") ~= "pending" then return end
  session:sleep(100)
end
