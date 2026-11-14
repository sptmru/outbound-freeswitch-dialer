-- A03 isolated lab ONLY. A02 transport/DID validation runs before this script.
local uuid = session:get_uuid()
local api = freeswitch.API()
-- start_uepoch is only available at finalization; use the live caller profile.
local dump = api:execute("uuid_dump", uuid)
local arrived = string.match(dump, "Caller%-Channel%-Created%-Time: (%d+)")
local function reject()
  freeswitch.consoleLog("ERR", "A03 journal admission failed\n")
  session:execute("respond", "503 Journal unavailable")
  session:hangup("NORMAL_TEMPORARY_FAILURE")
end
if not arrived or session:getVariable("a02_validated_did") ~= "+12025550100" or
  session:getVariable("a02_route_revision") ~= "fixture-v1" then reject(); return end
-- The journal agent is a separate process; native SQLite retries cannot block FS.
-- A curl total timeout also bounds a stopped/unresponsive journal process.
local port = argv[1] == "unavailable" and "8094" or "8093"
local base = "http://127.0.0.1:" .. port
local data = "uuid=" .. uuid .. "&arrived_us=" .. arrived
local response = api:execute("curl", base .. "/capture connect-timeout 1 timeout 1 post " .. data)
if response ~= "stored:" .. uuid or not session:ready() then reject(); return end
session:setVariable("a03_arrived_us", arrived)
session:setVariable("a03_durable", "true")
function a03_hangup(s)
  -- The state-change hook witnesses termination, but final CDR variables can
  -- still be unset and uuid_dump can already refuse this closing channel.
  local cause = s:getVariable("hangup_cause") or "UNKNOWN"
  local ended = s:getVariable("end_uepoch") or "0"
  local result = api:execute("curl", base .. "/terminal connect-timeout 1 timeout 1 post " ..
    data .. "&cause=" .. cause .. "&ended_us=" .. ended)
  if result ~= "stored:" .. uuid then
    freeswitch.consoleLog("ERR", "A03 terminal capture failed; retain admission for discovery\n")
  end
end
session:setHangupHook("a03_hangup")
session:execute("event", "Event-Name=CUSTOM,Event-Subclass=outbound_dialer::a03_durable")
-- No answer, audio, offers or outbound legs in this durability prototype.
session:sleep(30000)
if session:ready() then session:hangup("NORMAL_CLEARING") end
