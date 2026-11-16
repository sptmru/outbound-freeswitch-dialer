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
-- A committed admission receipt only allows parking until its fixed C03 transfer.
-- It never answers or starts media. The original native three-second guard stays
-- armed until the verified waiting continuation replaces it with queue deadline.
for attempt = 1, 10 do
  if not session:ready() then return end
  local admitted = post("admission")
  if string.match(admitted, "^admitted:[0-9a-f%-]+$") then
    session:execute("park")
    return
  end
  if admitted ~= "pending" then return end
  session:sleep(100)
end
