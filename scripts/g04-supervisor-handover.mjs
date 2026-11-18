import {
  admitNativeCallControl,
  nativeCallControlExecutor
} from "../apps/api/dist-test/native-call-control.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { endpoint, until, assertTone, power } from "./a05-media.mjs";
import { provisionAgentDirectory } from "../apps/api/dist-test/freeswitch/provisioning.js";
import {
  admitSupervisorMutation,
  supervisorExecutor
} from "../apps/api/dist-test/supervisor-coordination.js";

// Real native C07 commands and SIP/RTP. Only the admin identity/endpoint is seeded.
export async function supervisorHandoverFixture({ f, callId, command, limited, pass, direction }) {
  const user = (
    await f.pool.query(
      "insert into users(email,name,role,password_hash) values($1,'G04','admin','fixture') returning id",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0].id;
  const username = `supervisor_${randomUUID().replaceAll("-", "")}`;
  await f.pool.query(
    "insert into admin_supervisor_endpoints(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','G04',true)",
    [user, username]
  );
  const config = {
    FREESWITCH_GENERATED_CONFIG_DIR: `${process.argv[2]}/generated`,
    FREESWITCH_DOMAIN: "a04.invalid"
  };
  await provisionAgentDirectory(config, {
    sipUsername: username,
    sipPassword: "fixture",
    displayName: "G04"
  });
  await command("reloadxml");
  const phone = await endpoint({ username, password: "fixture", source: "127.0.0.6", frequency: 990 });
  await phone.register();
  const route = await until(async () => {
    const v = await command(`sofia_contact internal-webrtc/${username}@a04.invalid`);
    return v.startsWith("sofia/") ? v : false;
  }, "G04 supervisor registration");
  const adapter = supervisorExecutor(
    f.pool,
    limited.executor,
    config,
    { host: "127.0.0.1", port: 8021, password: "a02-disposable-only" },
    command
  );
  let sessionId, oldUuid;
  async function mutation(action, mode) {
    const r = await admitSupervisorMutation(f.pool, {
      action,
      mode,
      callId,
      sessionId,
      actorUserId: user,
      actorAuthVersion: 1,
      key: randomUUID(),
      endpoint: { sipUsername: username, route }
    });
    await adapter.wakeExecutor(r.rootId);
    sessionId = r.session.id;
    await until(
      async () => {
        await adapter.wakeExecutor(r.rootId);
        const s = (await f.pool.query("select * from call_supervisor_sessions where id=$1", [sessionId]))
          .rows[0];
        return s.state === (action === "stop" ? "ended" : "active") ? s : false;
      },
      "G04 explicit supervisor action",
      10000
    );
    return (await f.pool.query("select * from call_supervisor_sessions where id=$1", [sessionId])).rows[0];
  }
  async function received() {
    const offset = phone.received.length;
    await until(() => phone.received.length >= offset + 3200, "G04 monitoring decoded audio");
    return phone.received.slice(-2400);
  }
  return {
    async before(mode) {
      const s = await mutation("start");
      assert.equal(s.mode, "listen");
      await mutation("mode", mode);
      oldUuid = (
        await f.pool.query("select supervisor_leg_uuid from call_supervisor_sessions where id=$1", [
          sessionId
        ])
      ).rows[0].supervisor_leg_uuid;
      const samples = await received();
      assertTone(samples, 880);
      await pass(`G04.3 ${direction} real ${mode} supervision established before accepted transfer`, {
        sessionId,
        oldUuid
      });
    },
    async after(client, owner, deskSessionId) {
      const s = (await f.pool.query("select * from call_supervisor_sessions where id=$1", [sessionId]))
        .rows[0];
      assert.equal(s.state, "ended");
      assert.equal(await command(`uuid_exists ${oldUuid}`), "false");
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
            [sessionId]
          )
        ).rows[0].n,
        0
      );
      const bridge = (
        await f.pool.query(
          "select created_at from call_events where call_id=$1 and event_type='transfer_handover' order by created_at desc limit 1",
          [callId]
        )
      ).rows[0];
      assert.ok(s.ended_at <= bridge.created_at, "supervision teardown precedes ownership handover");
      await assert.rejects(() =>
        admitSupervisorMutation(f.pool, {
          action: "mode",
          mode: "join",
          sessionId,
          actorUserId: user,
          actorAuthVersion: 1,
          key: randomUUID(),
          endpoint: { sipUsername: username, route }
        })
      );
      const fresh = await mutation("start");
      assert.notEqual(fresh.id, s.id);
      assert.equal(fresh.mode, "listen", "replacement always starts in listen even after whisper/join");
      assert.notEqual(fresh.target_agent_leg_uuid, s.target_agent_leg_uuid);
      assertTone(await received(), 880);
      assert.notEqual(
        await command(`uuid_getvar ${fresh.supervisor_leg_uuid} eavesdrop_whisper_aleg`),
        "true"
      );
      assert.notEqual(
        await command(`uuid_getvar ${fresh.supervisor_leg_uuid} eavesdrop_whisper_bleg`),
        "true"
      );
      await this.isolation(client);
      await mutation("stop");
      const dtmf = await admitNativeCallControl(f.pool, {
        callId,
        actorUserId: owner.userId,
        actorAuthVersion: owner.authVersion,
        action: "dtmf",
        digit: "5",
        intent: { deskSessionId, expectedRevision: "1", bindingGeneration: "1", idempotencyKey: randomUUID() }
      });
      const controls = nativeCallControlExecutor(f.pool, limited.executor, {
        host: "127.0.0.1",
        port: 8021,
        password: "a02-disposable-only"
      });
      await until(async () => {
        await controls.wakeExecutor(dtmf.operationId);
        return (
          (await f.pool.query("select state from call_operations where id=$1", [dtmf.operationId])).rows[0]
            .state === "succeeded"
        );
      }, "G04 current-owner native DTMF job");
      await controls.wakeExecutor(dtmf.operationId);
      assert.equal(
        (
          await f.pool.query("select count(*)::int n from call_execution_attempts where operation_id=$1", [
            dtmf.operationId
          ])
        ).rows[0].n,
        1
      );
      await pass(`G04.1 ${direction} current-owner DTMF completes one actual fixed FS job after handover`, {
        operationId: dtmf.operationId,
        farEndReception: "not claimed"
      });

      await pass(
        `G04.3 ${direction} teardown confirmed before handover; new explicit session is listen-only`,
        { oldSessionId: s.id, newSessionId: fresh.id, oldUuid, mode: fresh.mode }
      );
    },
    async isolation(client) {
      const at = client.received.length;
      await until(() => client.received.length > at + 3200, "G04 recipient media after supervisor teardown");
      const samples = client.received.slice(-2400);
      assertTone(samples, 880);
      assert.ok(power(samples, 990) < 100, "old supervisor microphone never follows new owner");
    },
    close() {
      phone.close();
    }
  };
}
