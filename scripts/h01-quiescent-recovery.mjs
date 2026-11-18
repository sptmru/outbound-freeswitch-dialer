import assert from "node:assert/strict";
import { endpoint, until, assertTone } from "./a05-media.mjs";
import { recoverQuiescentCall } from "../apps/api/dist-test/inbound-recovery.js";

/** Deliberately seeded source conversations; real SIP/RTP and C03 recovery
 * leases. Terminal events are deliberately omitted from the SQL adapter. This
 * proves quiescent absence recovery, not the complete H01 restart matrix.
 */
export async function proveQuiescentRecovery({ f, phone, command, limited, pass, omit, persisted }) {
  for (const inbound of [false, true]) {
    const customer = await endpoint({
      username: "h01_customer",
      password: "fixture",
      source: "127.0.0.5",
      frequency: 880
    });
    const seeded = await f.seed({ inbound });
    const source = (
      await f.pool.query("select verified_endpoint from agent_desk_sessions where id=$1", [
        f.input.deskSessionId
      ])
    ).rows[0].verified_endpoint;
    try {
      for (const [uuid, route] of [
        [seeded.customerUuid, `sofia/internal-webrtc/sip:h01_customer@${customer.address}`],
        [seeded.agentUuid, source]
      ]) {
        assert.match(
          await command(
            `originate {origination_uuid=${uuid},outbound_dialer_call_id=${seeded.callId},hangup_after_bridge=false,park_after_bridge=true}${route} &park()`
          ),
          /^\+OK/
        );
        await until(
          async () => (await command(`uuid_getvar ${uuid} current_application`)) === "park",
          "H01 seeded channel parked"
        );
      }
      assert.match(await command(`uuid_bridge ${seeded.customerUuid} ${seeded.agentUuid}`), /^\+OK/);
      await until(
        async () => (await command(`uuid_getvar ${seeded.customerUuid} bridge_uuid`)) === seeded.agentUuid,
        "H01 actual bridge"
      );
      await until(
        () => customer.received.length >= 2400 && phone.received.length >= 2400,
        "H01 two-way decoded RTP"
      );
      const audio = [
        assertTone(customer.received.slice(-2400), 660),
        assertTone(phone.received.slice(-2400), 880)
      ];
      await persisted();
      const before = (await f.pool.query("select * from calls where id=$1", [seeded.callId])).rows[0];
      assert.deepEqual(
        await recoverQuiescentCall(f.pool, limited.executor, seeded.callId, command, () => true),
        { status: "inspected", value: "live" }
      );
      assert.equal(
        (await f.pool.query("select ended_at from calls where id=$1", [seeded.callId])).rows[0].ended_at,
        null
      );
      await pass(
        `H01 ${inbound ? "inbound" : "outbound"} quiescent live conversation survives recovery; real two-way media`,
        { audio }
      );
      omit.add(seeded.callId);
      for (const uuid of [seeded.customerUuid, seeded.agentUuid])
        await command(`uuid_kill ${uuid} NORMAL_CLEARING`);
      await until(
        async () =>
          (await command(`uuid_exists ${seeded.customerUuid}`)) === "false" &&
          (await command(`uuid_exists ${seeded.agentUuid}`)) === "false",
        "H01 concrete channels absent"
      );
      await persisted();
      assert.equal(
        (await f.pool.query("select ended_at from calls where id=$1", [seeded.callId])).rows[0].ended_at,
        null,
        "terminal adapter outage is real"
      );
      const result = await recoverQuiescentCall(f.pool, limited.executor, seeded.callId, command, () => true);
      assert.deepEqual(result, { status: "inspected", value: "observed_absence" });
      const after = (await f.pool.query("select * from calls where id=$1", [seeded.callId])).rows[0];
      assert.equal(after.state, "failed");
      assert.equal(after.outcome, "failed");
      assert.equal(after.terminal_source, "lifecycle_recovery");
      assert.deepEqual(
        [after.arrived_at, after.queue_deadline_at, after.campaign_id],
        [before.arrived_at, before.queue_deadline_at, before.campaign_id]
      );
      for (const table of [
        "call_operations",
        "call_capacity_reservations",
        "agent_call_slots",
        "call_legs"
      ]) {
        const predicate =
          table === "call_operations"
            ? "resolved_at is null"
            : table === "call_capacity_reservations"
              ? "state<>'released'"
              : table === "agent_call_slots"
                ? "state<>'free'"
                : "ended_at is null";
        assert.equal(
          (
            await f.pool.query(`select count(*)::int n from ${table} where call_id=$1 and ${predicate}`, [
              seeded.callId
            ])
          ).rows[0].n,
          0
        );
      }
      await recoverQuiescentCall(f.pool, limited.executor, seeded.callId, command, () => true);
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from call_events where call_id=$1 and event_type='lifecycle_recovery_absent'",
            [seeded.callId]
          )
        ).rows[0].n,
        2
      );
      await pass(
        `H01 ${inbound ? "inbound" : "outbound"} omitted terminal events recover exact legs, slot and capacity without duplicate evidence`,
        { callId: seeded.callId, result, before, after }
      );
    } finally {
      omit.delete(seeded.callId);
      for (const uuid of [seeded.customerUuid, seeded.agentUuid])
        if ((await command(`uuid_exists ${uuid}`)) === "true")
          await command(`uuid_kill ${uuid} NORMAL_CLEARING`);
      await customer.close();
    }
  }
}
