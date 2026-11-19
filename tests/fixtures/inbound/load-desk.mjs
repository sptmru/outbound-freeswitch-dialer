import { randomUUID } from "node:crypto";
import { signAuthToken } from "../../../apps/api/dist-test/auth/tokens.js";

export async function loadDesk(pool, config, campaignId, label, endpoint) {
  const email = `${label}@example.test`;
  const {
    rows: [user]
  } = await pool.query(
    "insert into users(email,name,role,password_hash) values($1,$2,'agent','fixture') returning id,auth_version",
    [email, label]
  );
  const username = `desk_${randomUUID().replaceAll("-", "")}`;
  const {
    rows: [agent]
  } = await pool.query(
    `insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered,status)
     values($1,$2,'fixture','fixture',$3,true,'ready') returning id`,
    [user.id, username, label]
  );
  await pool.query(
    "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
    [agent.id]
  );
  const phone = await endpoint?.(username);
  const pin = `sofia/internal-webrtc/sip:${username}@${phone?.address ?? "127.0.0.1:5060"}`;
  try {
    const {
      rows: [session]
    } = await pool.query(
      `insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,
         verified_endpoint,endpoint_pin,verified_generation,verified_at,actor_auth_version)
       values($1,$2,1,$3,clock_timestamp()+interval '5 minutes',true,$4,$4,1,clock_timestamp(),$5) returning id`,
      [agent.id, campaignId, username, pin, user.auth_version]
    );
    const token = signAuthToken(config, { sub: user.id, email, role: "agent", ver: user.auth_version });
    return {
      id: agent.id,
      userId: user.id,
      sessionId: session.id,
      phone,
      headers: { authorization: `Bearer ${token}` }
    };
  } catch (error) {
    await phone?.close();
    throw error;
  }
}

export function loadMutation(desk) {
  return {
    deskSessionId: desk.sessionId,
    expectedRevision: "1",
    bindingGeneration: "1",
    idempotencyKey: randomUUID()
  };
}
