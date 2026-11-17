import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createTransferOffer, mutateTransferOffer } from "../apps/api/dist-test/transfer-offers.js";
import { readInboundOffer } from "../apps/api/dist-test/inbound-dispatcher.js";
import { until, assertTone } from "./a05-media.mjs";

/** Runs only inside the existing network-none E02 lab, on its real connected call.
 * Recipient media is deliberately absent: G01 offer closure must send zero commands.
 */
export async function proveTransferSourceContinuity({ f, c, phone, command, pass }) {
  const user = (
    await f.pool.query(
      "insert into users(email,name,role,password_hash) values($1,'G01 recipient','agent','fixture') returning id",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0].id;
  const recipient = (
    await f.pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','G01 recipient',true) returning id",
      [user, randomUUID()]
    )
  ).rows[0].id;
  const campaign = (await f.pool.query("select campaign_id from calls where id=$1", [c.row.uuid])).rows[0]
    .campaign_id;
  const desk = (
    await f.pool.query(
      "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at,actor_auth_version) values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,'sip:g01@127.0.0.4',1,clock_timestamp(),1) returning id",
      [recipient, campaign, randomUUID()]
    )
  ).rows[0].id;
  await f.pool.query(
    "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
    [recipient]
  );
  const source = { userId: f.userId, agentId: f.agentId, authVersion: 1 },
    target = { userId: user, agentId: recipient, authVersion: 1 };
  const input = (session) => ({
    deskSessionId: session,
    expectedRevision: "1",
    bindingGeneration: "1",
    idempotencyKey: randomUUID()
  });
  const state = async () =>
    (
      await f.pool.query(
        `select c.agent_id,c.state,c.ended_at,c.campaign_id,to_jsonb(s) slot,to_jsonb(p) participant,l.freeswitch_uuid
    from calls c join agent_call_slots s on s.agent_id=c.agent_id join call_participants p on p.id=s.participant_id join call_legs l on l.participant_id=p.id where c.id=$1`,
        [c.row.uuid]
      )
    ).rows[0];
  const before = await state();
  const commands = (
    await f.pool.query("select count(*)::int n from call_operations where call_id=$1", [c.row.uuid])
  ).rows[0].n;
  for (const mode of ["ignore", "cancel", "expiry"]) {
    await f.pool.query(
      "update agent_desk_sessions set verified_at=clock_timestamp() where id=any($1::uuid[])",
      [[desk, f.input.deskSessionId]]
    );
    const t = await createTransferOffer(f.pool, source, c.row.uuid, {
      ...input(f.input.deskSessionId),
      recipientAgentId: recipient
    });
    assert.equal((await readInboundOffer(f.pool, target, desk)).offer.id, t.offerId);
    if (mode === "expiry") {
      await until(
        async () =>
          (
            await f.pool.query("select deadline_at<=clock_timestamp() due from call_transfers where id=$1", [
              t.transfer.id
            ])
          ).rows[0].due,
        "G01 database transfer deadline",
        25000
      );
      assert.equal((await readInboundOffer(f.pool, target, desk)).offer, null);
    } else {
      const result = await mutateTransferOffer(
        f.pool,
        mode === "cancel" ? source : target,
        mode === "cancel" ? t.transfer.id : t.offerId,
        input(mode === "cancel" ? f.input.deskSessionId : desk),
        mode,
        mode === "cancel" ? c.row.uuid : undefined
      );
      assert.equal(result.status, "applied");
    }
    assert.deepEqual(await state(), before);
    assert.equal(await command(`uuid_exists ${c.row.uuid}`), "true");
    assert.equal(await command(`uuid_getvar ${c.row.uuid} bridge_uuid`), before.freeswitch_uuid);
    const samples = phone.received.length;
    await until(() => phone.received.length >= samples + 2400, `G01 ${mode} fresh source RTP`);
    const tone = assertTone(phone.received.slice(-2400), 880);
    assert.equal(
      (await f.pool.query("select count(*)::int n from call_operations where call_id=$1", [c.row.uuid]))
        .rows[0].n,
      commands
    );
    assert.equal(
      (await f.pool.query("select state from agent_call_slots where agent_id=$1", [recipient])).rows[0].state,
      "free"
    );
    const rows = (
      await f.pool.query(
        "select t.state,t.reason,o.state offer_state from call_transfers t join call_offers o on o.transfer_id=t.id where t.id=$1",
        [t.transfer.id]
      )
    ).rows[0];
    assert.equal(rows.state, mode === "expiry" ? "expired" : mode === "cancel" ? "canceled" : "declined");
    await pass(
      `G01.2 ${mode}: real source bridge/ownership/slot/participation retained with decoded customer RTP and zero new commands`,
      { transfer: t.transfer.id, ...rows, tone, source: before }
    );
    await delay(10);
  }
}
