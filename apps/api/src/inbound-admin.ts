import type pg from "pg";
import type {
  DeleteResponse,
  InboundAdminMutation,
  InboundAppliedState,
  InboundFlowDefinition,
  InboundFlowSnapshot,
  InboundNumberSnapshot,
  InboundQueueSnapshot,
  SaveInboundFlowRequest,
  SaveInboundNumberRequest,
  SaveInboundQueueRequest
} from "@outbound-dialer/shared";
import { requestFingerprint } from "./call-coordination-contracts.js";

export type InboundResource = "numbers" | "queues" | "flows";
export type ConfigurationActor = { id: string; authVersion: number; requestId: string };
type Snapshot = InboundNumberSnapshot | InboundQueueSnapshot | InboundFlowSnapshot;
type Input =
  SaveInboundNumberRequest | SaveInboundQueueRequest | SaveInboundFlowRequest | InboundAdminMutation;
export class InboundAdminError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409
  ) {
    super(code);
  }
}

// This is the configuration-only lock, never the call admission/media lock.
// Take it before campaign/recording/configuration rows, including explicit SELECT locks.
export async function lockInboundConfiguration(db: pg.PoolClient) {
  await db.query("select pg_advisory_xact_lock(72204,0)");
}

function applyState(row: pg.QueryResultRow, state: pg.QueryResultRow): InboundAppliedState {
  const error = state.apply_error && state.error_revision === state.desired_revision;
  return {
    desiredRevision: row.desired_revision,
    appliedRevision: row.applied_revision,
    status: error
      ? "error"
      : row.applied_revision === row.desired_revision && state.verified_at
        ? "applied"
        : "pending",
    error: error ? state.apply_error : null
  };
}
function numberSnapshot(row: pg.QueryResultRow, state: pg.QueryResultRow): InboundNumberSnapshot {
  return {
    id: row.id,
    revision: row.desired_revision,
    label: row.label,
    did: row.normalized_did,
    queueId: row.queue_id,
    enabled: row.enabled,
    apply: applyState(row, state)
  };
}
function queueSnapshot(row: pg.QueryResultRow, state: pg.QueryResultRow): InboundQueueSnapshot {
  return {
    id: row.id,
    revision: row.desired_revision,
    name: row.name,
    campaignId: row.campaign_id,
    waitingRecordingId: row.waiting_audio_id,
    noAnswerFlowVersionId: row.no_answer_flow_version_id,
    configuration: {
      offerTimeoutMs: row.offer_timeout_ms,
      queueTimeoutMs: row.queue_timeout_ms,
      connectTimeoutMs: row.connect_timeout_ms,
      transferTimeoutMs: row.transfer_timeout_ms,
      maxWaitingCalls: row.max_waiting_calls,
      overflowPolicy: row.overflow_policy,
      overflowFlowVersionId: row.overflow_flow_version_id
    },
    apply: applyState(row, state)
  };
}
function flowSnapshot(row: pg.QueryResultRow): InboundFlowSnapshot {
  return {
    id: row.id,
    revision: String(row.version),
    campaignId: row.campaign_id,
    name: row.name,
    enabled: row.enabled,
    versionId: row.version_id,
    definition: { flowTimeoutMs: row.flow_timeout_ms, actions: row.actions }
  };
}
const flowSelect = `select f.*,v.id as version_id,v.version,v.flow_timeout_ms,v.actions
  from inbound_flows f join lateral (select * from inbound_flow_versions
    where flow_id=f.id order by version desc limit 1) v on true`;

export async function listInboundConfiguration(pool: pg.Pool, resource: InboundResource) {
  // One SQL snapshot keeps desired/applied/error and entities mutually consistent.
  if (resource === "flows") {
    const rows = (await pool.query(`${flowSelect} where f.deleted_at is null order by f.created_at,f.id`))
      .rows;
    return { items: rows.map(flowSnapshot) };
  }
  const table = resource === "numbers" ? "inbound_numbers" : "inbound_queues";
  const rows = (
    await pool.query(`select t.*,row_to_json(s) as fs from ${table} t
    cross join inbound_freeswitch_configuration s order by t.created_at,t.id`)
  ).rows;
  return {
    items: rows.map((r) => (resource === "numbers" ? numberSnapshot(r, r.fs) : queueSnapshot(r, r.fs)))
  };
}

async function campaign(db: pg.PoolClient, id: string, allowArchived = false) {
  const row = (await db.query("select status from campaigns where id=$1 for share", [id])).rows[0];
  if (!row || (!allowArchived && row.status === "archived"))
    throw new InboundAdminError("campaign_unavailable");
}
async function recording(db: pg.PoolClient, id: string, campaignId: string, timeout?: number) {
  // FOR SHARE also serializes soft deletion; key-share alone does not block it.
  const row = (
    await db.query("select * from recordings where id=$1 and campaign_id=$2 and is_active for share", [
      id,
      campaignId
    ])
  ).rows[0];
  if (
    !row ||
    !row.runtime_file_path ||
    (timeout !== undefined && (!row.duration_seconds || Number(row.duration_seconds) * 1000 > timeout))
  )
    throw new InboundAdminError("audio_unavailable");
}
async function definitionReferences(
  db: pg.PoolClient,
  definition: InboundFlowDefinition,
  campaignId: string
) {
  // Deterministic recording lock order matches the schema snapshot trigger.
  for (const action of [...definition.actions].sort((a, b) =>
    (a.type === "play_audio" ? a.recordingId : "").localeCompare(b.type === "play_audio" ? b.recordingId : "")
  )) {
    if (action.type === "play_audio") await recording(db, action.recordingId, campaignId, action.timeoutMs);
    if (
      action.type === "forward_external" &&
      (await db.query("select 1 from inbound_numbers where normalized_did=$1", [action.target])).rowCount
    )
      throw new InboundAdminError("owned_did_forwarding_loop");
  }
}
async function flowReference(db: pg.PoolClient, id: string, campaignId: string) {
  const row = (
    await db.query(
      `select v.*,f.enabled,f.deleted_at from inbound_flow_versions v
    join inbound_flows f on f.id=v.flow_id where v.id=$1 and v.campaign_id=$2`,
      [id, campaignId]
    )
  ).rows[0];
  if (!row || !row.enabled || row.deleted_at) throw new InboundAdminError("flow_unavailable");
  await definitionReferences(db, { actions: row.actions, flowTimeoutMs: row.flow_timeout_ms }, campaignId);
}
async function assertFlowUnreferenced(db: pg.PoolClient, id: string) {
  if (
    (
      await db.query(
        `select 1 from inbound_queues q join inbound_flow_versions v on
    v.id=q.no_answer_flow_version_id or v.id=q.overflow_flow_version_id where v.flow_id=$1 limit 1`,
        [id]
      )
    ).rowCount
  )
    throw new InboundAdminError("configuration_in_use");
}

async function saveNumber(db: pg.PoolClient, id: string | null, input: SaveInboundNumberRequest) {
  // Include historical versions: adding a DID must not create a loop in an active old snapshot.
  if (
    (
      await db.query(
        `select 1 from inbound_flow_versions v,jsonb_array_elements(v.actions) a
    where a->>'type'='forward_external' and a->>'target'=$1 limit 1`,
        [input.did]
      )
    ).rowCount
  )
    throw new InboundAdminError("owned_did_forwarding_loop");
  const queue = (await db.query("select * from inbound_queues where id=$1", [input.queueId])).rows[0];
  if (!queue) throw new InboundAdminError("queue_unavailable");
  await campaign(db, queue.campaign_id, !input.enabled);
  if (!id && (await db.query("select count(*)::int as n from inbound_numbers")).rows[0].n >= 200)
    throw new InboundAdminError("route_limit_exceeded");
  const result = id
    ? await db.query(
        `update inbound_numbers set label=$2,normalized_did=$3,queue_id=$4,enabled=$5
    where id=$1 returning *`,
        [id, input.label, input.did, input.queueId, input.enabled]
      )
    : await db.query(
        `insert into inbound_numbers(label,normalized_did,queue_id,enabled) values($1,$2,$3,$4) returning *`,
        [input.label, input.did, input.queueId, input.enabled]
      );
  return result.rows[0];
}
async function saveQueue(db: pg.PoolClient, id: string | null, input: SaveInboundQueueRequest) {
  await campaign(db, input.campaignId);
  if (input.waitingRecordingId) await recording(db, input.waitingRecordingId, input.campaignId);
  for (const version of [input.noAnswerFlowVersionId, input.configuration.overflowFlowVersionId])
    if (version) await flowReference(db, version, input.campaignId);
  const c = input.configuration;
  const values = [
    input.campaignId,
    input.name,
    input.waitingRecordingId,
    input.noAnswerFlowVersionId,
    c.offerTimeoutMs,
    c.queueTimeoutMs,
    c.connectTimeoutMs,
    c.transferTimeoutMs,
    c.maxWaitingCalls,
    c.overflowPolicy,
    c.overflowFlowVersionId
  ];
  return (
    id
      ? await db.query(
          `update inbound_queues set campaign_id=$1,name=$2,waiting_audio_id=$3,no_answer_flow_version_id=$4,
    offer_timeout_ms=$5,queue_timeout_ms=$6,connect_timeout_ms=$7,transfer_timeout_ms=$8,max_waiting_calls=$9,
    overflow_policy=$10,overflow_flow_version_id=$11 where id=$12 returning *`,
          [...values, id]
        )
      : await db.query(
          `insert into inbound_queues(campaign_id,name,waiting_audio_id,no_answer_flow_version_id,
    offer_timeout_ms,queue_timeout_ms,connect_timeout_ms,transfer_timeout_ms,max_waiting_calls,overflow_policy,overflow_flow_version_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
          values
        )
  ).rows[0];
}
async function saveFlow(db: pg.PoolClient, id: string | null, input: SaveInboundFlowRequest) {
  await campaign(db, input.campaignId, input.enabled === false);
  await definitionReferences(db, input.definition, input.campaignId);
  if (id && input.enabled === false) await assertFlowUnreferenced(db, id);
  const flow = id
    ? (
        await db.query("update inbound_flows set name=$2,enabled=$3 where id=$1 returning *", [
          id,
          input.name,
          input.enabled ?? true
        ])
      ).rows[0]
    : (
        await db.query("insert into inbound_flows(campaign_id,name,enabled) values($1,$2,$3) returning *", [
          input.campaignId,
          input.name,
          input.enabled ?? true
        ])
      ).rows[0];
  await db.query(
    `insert into inbound_flow_versions(flow_id,campaign_id,version,flow_timeout_ms,actions)
    select $1,$2,coalesce(max(version),0)+1,$3,$4 from inbound_flow_versions where flow_id=$1`,
    [flow.id, input.campaignId, input.definition.flowTimeoutMs, JSON.stringify(input.definition.actions)]
  );
  return (await db.query(`${flowSelect} where f.id=$1`, [flow.id])).rows[0];
}

export async function mutateInboundConfiguration(
  pool: pg.Pool,
  actor: ConfigurationActor,
  resource: InboundResource,
  method: "POST" | "PATCH" | "DELETE",
  id: string | null,
  input: Input,
  checkpoint?: (db: pg.PoolClient) => Promise<void>
): Promise<Snapshot | DeleteResponse> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local lock_timeout='1500ms'");
    await db.query("set local statement_timeout='5000ms'");
    await lockInboundConfiguration(db);
    const user = (
      await db.query("select role,is_active,auth_version from users where id=$1 for share", [actor.id])
    ).rows[0];
    if (!user?.is_active || user.role !== "admin" || user.auth_version !== actor.authVersion)
      throw new InboundAdminError("administrator_access_changed", 403);
    const fingerprint = requestFingerprint(method, `/admin/inbound-${resource}`, id, input);
    const replay = (
      await db.query(
        "select * from inbound_configuration_mutations where actor_user_id=$1 and idempotency_key=$2",
        [actor.id, input.idempotencyKey]
      )
    ).rows[0];
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new InboundAdminError("idempotency_conflict");
      await db.query("commit");
      return replay.response;
    }
    let old: pg.QueryResultRow | undefined;
    if (id) {
      const sql =
        resource === "flows"
          ? `${flowSelect} where f.id=$1 and f.deleted_at is null`
          : `select * from ${resource === "numbers" ? "inbound_numbers" : "inbound_queues"} where id=$1`;
      old = (await db.query(sql, [id])).rows[0];
      if (!old) throw new InboundAdminError("not_found", 404);
      const revision = resource === "flows" ? String(old.version) : old.desired_revision;
      if (revision !== input.expectedRevision) throw new InboundAdminError("revision_conflict");
      if ("campaignId" in input && old.campaign_id !== input.campaignId)
        throw new InboundAdminError("campaign_immutable");
    } else if (input.expectedRevision !== null) throw new InboundAdminError("revision_conflict");
    let result: Snapshot | DeleteResponse;
    if (method === "DELETE") {
      if (resource === "flows") {
        await assertFlowUnreferenced(db, id!);
        await db.query("update inbound_flows set enabled=false,deleted_at=clock_timestamp() where id=$1", [
          id
        ]);
      } else if (resource === "numbers") {
        if (old!.enabled) throw new InboundAdminError("disable_before_delete");
        await db.query("delete from inbound_numbers where id=$1", [id]);
      } else await db.query("delete from inbound_queues where id=$1", [id]);
      result = { ok: true };
    } else {
      const row =
        resource === "numbers"
          ? await saveNumber(db, id, input as SaveInboundNumberRequest)
          : resource === "queues"
            ? await saveQueue(db, id, input as SaveInboundQueueRequest)
            : await saveFlow(db, id, input as SaveInboundFlowRequest);
      const state = (await db.query("select * from inbound_freeswitch_configuration")).rows[0];
      result =
        resource === "numbers"
          ? numberSnapshot(row, state)
          : resource === "queues"
            ? queueSnapshot(row, state)
            : flowSnapshot(row);
    }
    await db.query(
      `insert into inbound_configuration_mutations(actor_user_id,idempotency_key,fingerprint,method,resource,resource_id,revision,request_id,response)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        actor.id,
        input.idempotencyKey,
        fingerprint,
        method,
        resource,
        "id" in result ? result.id : id,
        "revision" in result ? result.revision : input.expectedRevision,
        actor.requestId,
        JSON.stringify(result)
      ]
    );
    await checkpoint?.(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "23505") throw new InboundAdminError("duplicate_configuration");
      if (error.code === "23503") throw new InboundAdminError("configuration_in_use");
      if (error.code === "55P03" || error.code === "57014") throw new InboundAdminError("configuration_busy");
    }
    throw error;
  } finally {
    db.release();
  }
}
