-- C03/H01 opt-in single-command journal. SQLite lives in the existing FS db
-- volume. The command runs outside the short journal transaction. A tombstone
-- wins atomically against a delayed sender; an old incarnation can never send.
local function uuid(v) return type(v) == "string" and #v == 36 and v:match("^[0-9a-f%-]+$") end
local function quote(v) return "'" .. tostring(v):gsub("'", "''") .. "'" end
local function hex(v) return (v:gsub(".", function(c) return string.format("%02x", string.byte(c)) end)) end
local api = freeswitch.API()
local boot = api:execute("global_getvar", "core_uuid"):gsub("%s+$", "")
local mode, expected, job, operation = argv[1], argv[2], argv[3], argv[4]
if not uuid(boot) then stream:write("-ERR invalid incarnation"); return end
if mode == "boot" then stream:write(boot); return end
if not uuid(expected) or not uuid(job) or not uuid(operation) then stream:write("-ERR invalid identity"); return end
if expected ~= boot and mode ~= "ack" then
  stream:write(mode == "execute" and "-ERR obsolete incarnation" or (boot .. "|obsolete|"))
  return
end
local db = freeswitch.Dbh("sqlite://" .. freeswitch.getGlobalVariable("db_dir") .. "/outbound-commands.sqlite")
if not db:connected() then stream:write("-ERR journal unavailable"); return end
local function sql(q) if not db:query(q) then error("command journal unavailable") end end
local function row()
  local result
  sql("select * from receipts where job=" .. quote(job))
  db:query("select * from receipts where job=" .. quote(job), function(r) result = r end)
  return result
end
local function receipt(r)
  return boot .. "|" .. r.state .. "|" .. hex(r.body or "") .. "|" .. (r.producer or "")
end
local ok, result = pcall(function()
  sql("PRAGMA busy_timeout=250")
  sql("PRAGMA synchronous=FULL")
  sql("PRAGMA max_page_count=2048")
  sql("create table if not exists receipts(job text primary key,operation text unique not null,core text not null,state text not null,body text,producer text)")
  -- A revocation must survive SQL ACK until this incarnation ends: the original
  -- bytes may still be held in a transport relay. Old-boot frames are rejected
  -- above before they can claim a receipt after startup recycling.
  sql("delete from receipts where state='revoked' and core<>" .. quote(boot))
  if mode == "ack" then
    sql("delete from receipts where job=" .. quote(job) .. " and operation=" .. quote(operation) .. " and core=" .. quote(expected) .. " and (state<>'revoked' or core<>" .. quote(boot) .. ")")
    return "+OK"
  end
  if mode == "producer" then
    local state = argv[5]
    if state ~= "started" and state ~= "completed" and state ~= "failed" and state ~= "finished" then return "-ERR invalid producer state" end
    sql("update receipts set producer=" .. quote(state) .. " where job=" .. quote(job) .. " and operation=" .. quote(operation) .. " and core=" .. quote(boot))
    return "+OK"
  end
  if mode ~= "execute" and mode ~= "inspect" then return "-ERR invalid action" end
  sql("BEGIN IMMEDIATE")
  local r = row()
  if not r then
    local count = 256
    db:query("select count(*) as n from receipts", function(v) count = tonumber(v.n) end)
    if count >= 256 then sql("ROLLBACK"); return "-ERR command journal full" end
    sql("insert into receipts(job,operation,core,state) values(" .. quote(job) .. "," .. quote(operation) .. "," .. quote(boot) .. "," .. quote(mode == "execute" and "started" or "revoked") .. ")")
    r = row()
    sql("COMMIT")
    if mode == "inspect" then return receipt(r) end
  else
    sql("COMMIT")
    if r.operation ~= operation or r.core ~= boot then return "-ERR journal identity mismatch" end
    if mode == "inspect" then return receipt(r) end
    -- Includes a revocation committed before the original bytes reached FS.
    return r.state == "completed" and r.body or "-ERR sender already claimed or revoked"
  end
  local command = table.concat(argv, " ", 5)
  if #command == 0 or #command > 16384 or command:find("[\r\n]") then return "-ERR invalid command" end
  local target = command:match("^uuid_transfer ([0-9a-f%-]+) ")
  if target then
    api:execute("uuid_setvar_multi", target .. " outbound_dialer_command_job=" .. job .. ";outbound_dialer_command_core=" .. boot)
  end
  local body = api:executeString(command)
  -- Result persistence precedes both the wrapper return and BACKGROUND_JOB.
  sql("update receipts set state='completed',body=" .. quote(body:sub(1,4096)) .. " where job=" .. quote(job))
  return body
end)
if not ok then pcall(function() db:query("ROLLBACK") end) end
db:release()
stream:write(ok and result or "-ERR command journal unavailable")
