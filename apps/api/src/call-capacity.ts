import type pg from "pg";

// A06 DB policy. FS/pre-admission hard guards are applied and verified by D02.
export const defaultCapacityLimits = Object.freeze({
  queue: 40,
  channels: 72,
  trunk: 32,
  forwarding: 4,
  supervisor: 4,
  transferOverlap: 4,
  fsChannels: 80,
  fsTrunk: 40,
  preAdmission: 8
});
export type CapacityLimits = { -readonly [K in keyof typeof defaultCapacityLimits]: number };
export const CAPACITY_SETTINGS_KEY = "calls.capacity_limits";
const maxima: CapacityLimits = {
  queue: 200,
  channels: 184,
  trunk: 64,
  forwarding: 8,
  supervisor: 8,
  transferOverlap: 8,
  fsChannels: 200,
  fsTrunk: 80,
  preAdmission: 16
};
export function validateCapacityLimits(value: unknown): CapacityLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_capacity_limits");
  const candidate = value as Record<string, number>;
  if (Object.keys(candidate).length !== Object.keys(maxima).length)
    throw new Error("invalid_capacity_limits");
  for (const key of Object.keys(maxima) as (keyof CapacityLimits)[]) {
    const min = key === "fsChannels" ? 16 : key === "fsTrunk" ? 2 : 1;
    if (!Number.isSafeInteger(candidate[key]) || candidate[key]! < min || candidate[key]! > maxima[key])
      throw new Error("invalid_capacity_limits");
  }
  if (
    candidate.channels! + candidate.preAdmission! > candidate.fsChannels! ||
    candidate.trunk! + candidate.preAdmission! > candidate.fsTrunk!
  )
    throw new Error("pre_admission_headroom");
  return { ...candidate } as CapacityLimits;
}

export type CapacityKind =
  "inbound" | "outbound_customer" | "browser" | "supervisor" | "transfer" | "forward";
type Resource =
  | "queue_waiting"
  | "customer_channel"
  | "browser_channel"
  | "supervisor_channel"
  | "transfer_overlap"
  | "trunk_call"
  | "external_forward";
export interface CapacityRequest {
  kind: CapacityKind;
  callId: string;
  operationId: string;
  generation: string;
  agentId?: string;
  callLegId?: string;
  supervisorSessionId?: string;
}
export interface CapacityToken {
  id: string;
  operationId: string;
  callId: string;
  generation: string;
}
interface ClaimRow {
  id: string;
  operation_id: string;
  call_id: string;
  generation: string;
  agent_id: string | null;
  call_leg_id: string | null;
  supervisor_session_id: string | null;
  resource_type: Resource;
  scope_id: string;
  units: number;
  state: string;
}
export class CapacityError extends Error {
  constructor(
    readonly reason: string,
    readonly resource?: string
  ) {
    super(reason);
  }
}
const token = (r: ClaimRow): CapacityToken => ({
  id: r.id,
  operationId: r.operation_id,
  callId: r.call_id,
  generation: r.generation
});

/** Internal SQL interface created by CallAdmission. Requires declared/locked parents.
 * No ESL, pool acquisition, commit, TTL release or retry is performed here.
 */
export class CallCapacity {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly assertLocked: (callId?: string, agentId?: string) => void
  ) {}

  async limits() {
    this.assertLocked();
    const row = (
      await this.client.query("select value_json from system_settings where key=$1", [CAPACITY_SETTINGS_KEY])
    ).rows[0];
    return validateCapacityLimits(row ? row.value_json : defaultCapacityLimits);
  }
  // Configuration adapters must enter the same gate. No eviction/rewrite of claims.
  async configure(limits: CapacityLimits) {
    this.assertLocked();
    const checked = validateCapacityLimits(limits);
    await this.client.query(
      `insert into system_settings(key,value_json) values($1,$2::jsonb)
      on conflict(key) do update set value_json=excluded.value_json`,
      [CAPACITY_SETTINGS_KEY, JSON.stringify(checked)]
    );
  }
  async usage() {
    this.assertLocked();
    return (
      await this.client.query<{ resource_type: Resource; scope_id: string; used: string }>(
        `select resource_type,scope_id,sum(units)::text as used from call_capacity_reservations
       where state<>'released' group by resource_type,scope_id order by resource_type,scope_id`
      )
    ).rows;
  }
  async claim(input: CapacityRequest) {
    this.assertLocked(input.callId, input.agentId);
    const call = (await this.client.query("select * from calls where id=$1", [input.callId])).rows[0];
    if (!call) throw new CapacityError("call_missing");
    if ((input.kind === "browser" || input.kind === "transfer") && !input.agentId)
      throw new CapacityError("agent_required");
    if (input.kind === "supervisor" && !input.supervisorSessionId)
      throw new CapacityError("supervisor_required");
    const plan: { resource: Resource; scope: string }[] = [];
    const add = (resource: Resource, scope = "deployment") => plan.push({ resource, scope });
    switch (input.kind) {
      case "inbound":
        if (call.direction !== "inbound" || !call.inbound_queue_id) throw new CapacityError("queue_mismatch");
        add("queue_waiting", call.inbound_queue_id);
        add("customer_channel");
        add("trunk_call", "default");
        break;
      case "outbound_customer":
        if (call.direction !== "outbound") throw new CapacityError("direction_mismatch");
        add("customer_channel");
        add("trunk_call", "default");
        break;
      case "browser":
        add("browser_channel");
        break;
      case "supervisor":
        add("supervisor_channel");
        break;
      case "transfer":
        add("browser_channel");
        add("transfer_overlap");
        break;
      case "forward":
        add("customer_channel");
        add("trunk_call", "default");
        add("external_forward");
        break;
      default:
        throw new CapacityError("invalid_capacity_kind");
    }
    plan.sort((a, b) => a.resource.localeCompare(b.resource) || a.scope.localeCompare(b.scope));
    // Read operation/child rows before rank-7 capacity rows; no late parent locks.
    const operation = (
      await this.client.query("select * from call_operations where id=$1", [input.operationId])
    ).rows[0];
    if (!operation || operation.call_id !== input.callId || operation.generation !== input.generation)
      throw new CapacityError("operation_mismatch");
    const existing = (
      await this.client.query<ClaimRow>(
        "select * from call_capacity_reservations where operation_id=$1 order by resource_type,scope_id",
        [input.operationId]
      )
    ).rows;
    if (existing.length) {
      if (
        existing.length !== plan.length ||
        existing.some(
          (r, i) =>
            r.call_id !== input.callId ||
            r.generation !== input.generation ||
            r.agent_id !== (input.agentId ?? null) ||
            r.call_leg_id !== (input.callLegId ?? null) ||
            r.supervisor_session_id !== (input.supervisorSessionId ?? null) ||
            r.units !== 1 ||
            r.resource_type !== plan[i]!.resource ||
            r.scope_id !== plan[i]!.scope
        )
      )
        throw new CapacityError("capacity_replay_conflict");
      // Replay never revives released permits, rechecks a reduced limit, or authorizes an ESL send.
      return {
        replayed: true,
        usable: existing.every((r) => r.state !== "released"),
        tokens: existing.map(token)
      };
    }
    if (call.ended_at || ["completed", "failed", "canceled"].includes(call.state))
      throw new CapacityError("call_closed");
    if (operation.state !== "pending" || operation.resolved_at)
      throw new CapacityError("operation_not_pending");
    if (
      input.kind === "inbound" &&
      (call.state !== "queued" || call.queue_exited_at || call.fallback_started_at)
    )
      throw new CapacityError("queue_closed");
    const limits = await this.limits();
    const usage = await this.usage();
    const used = (resources: Resource[], scope?: string) =>
      usage
        .filter((r) => resources.includes(r.resource_type) && (!scope || r.scope_id === scope))
        .reduce((n, r) => n + BigInt(r.used), 0n);
    const check = (name: string, current: bigint, delta: number, limit: number) => {
      if (delta > 0 && current + BigInt(delta) > BigInt(limit))
        throw new CapacityError("capacity_exceeded", name);
    };
    const delta = (...resources: Resource[]) => plan.filter((p) => resources.includes(p.resource)).length;
    const channels: Resource[] = ["customer_channel", "browser_channel", "supervisor_channel"];
    check("channels", used(channels), delta(...channels), limits.channels);
    check("trunk", used(["trunk_call"]), delta("trunk_call"), limits.trunk);
    check("forwarding", used(["external_forward"]), delta("external_forward"), limits.forwarding);
    check("supervisor", used(["supervisor_channel"]), delta("supervisor_channel"), limits.supervisor);
    check("transferOverlap", used(["transfer_overlap"]), delta("transfer_overlap"), limits.transferOverlap);
    check("queue", used(["queue_waiting"]), delta("queue_waiting"), limits.queue);
    if (input.kind === "inbound") {
      const queue = (
        await this.client.query("select max_waiting_calls from inbound_queues where id=$1", [
          call.inbound_queue_id
        ])
      ).rows[0];
      if (!queue) throw new CapacityError("queue_mismatch");
      check("queue_waiting", used(["queue_waiting"], call.inbound_queue_id), 1, queue.max_waiting_calls);
    }
    // All budget checks precede the first insert; any SQL error still rolls back the outer gate.
    const tokens: CapacityToken[] = [];
    for (const p of plan) {
      const row = (
        await this.client.query<ClaimRow>(
          `insert into call_capacity_reservations
        (operation_id,call_id,generation,agent_id,call_leg_id,supervisor_session_id,resource_type,scope_id)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
          [
            input.operationId,
            input.callId,
            input.generation,
            input.agentId ?? null,
            input.callLegId ?? null,
            input.supervisorSessionId ?? null,
            p.resource,
            p.scope
          ]
        )
      ).rows[0]!;
      tokens.push(token(row));
    }
    return { replayed: false, usable: true, tokens };
  }
  async transition(claim: CapacityToken, state: "in_use" | "releasing" | "uncertain") {
    this.assertLocked(claim.callId);
    const result = await this.client.query(
      `update call_capacity_reservations set state=$5
      where id=$1 and operation_id=$2 and call_id=$3 and generation=$4 and state<>'released'
        and (state<>'uncertain' or $5 in ('uncertain','releasing'))
        and (state<>'releasing' or $5 in ('uncertain','releasing'))`,
      [claim.id, claim.operationId, claim.callId, claim.generation, state]
    );
    return result.rowCount === 1;
  }
  async release(claim: CapacityToken, cleanupConfirmed: boolean) {
    this.assertLocked(claim.callId);
    if (!cleanupConfirmed) return false;
    // No ACK, timeout or lease proves that a delayed call command cannot create media.
    const unresolved = await this.client.query(
      "select 1 from call_operations where call_id=$1 and resolved_at is null limit 1",
      [claim.callId]
    );
    if (unresolved.rowCount) return false;
    const result = await this.client.query(
      `update call_capacity_reservations set state='released',released_at=clock_timestamp()
      where id=$1 and operation_id=$2 and call_id=$3 and generation=$4 and state<>'released'`,
      [claim.id, claim.operationId, claim.callId, claim.generation]
    );
    return result.rowCount === 1;
  }
}

// Capacity failure cannot enter another forward/overflow. Playback reuses a retained
// admitted customer channel and an absolute bounded flow deadline (F03/F04 execute it).
export function capacityFailureContinuation(input: {
  admitted: boolean;
  customerClaimRetained: boolean;
  nextAction: string;
  now: number;
  deadline: number;
}): "reject" | "play_audio" | "hangup" {
  if (!input.admitted) return "reject";
  return input.customerClaimRetained &&
    input.nextAction === "play_audio" &&
    Number.isFinite(input.now) &&
    Number.isFinite(input.deadline) &&
    input.deadline > input.now &&
    input.deadline - input.now <= 90_000
    ? "play_audio"
    : "hangup";
}
