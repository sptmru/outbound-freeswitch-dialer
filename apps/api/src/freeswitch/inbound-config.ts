import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type pg from "pg";
import { SaxesParser } from "saxes";
import type { AppConfig } from "../config.js";
import { sendFreeSwitchApiCommand } from "../esl.js";
import { atomicConfigurationWrite, LockedConfigurationWriter } from "./configuration-files.js";
export { atomicConfigurationWrite } from "./configuration-files.js";

export interface InboundRoute {
  id: string;
  normalized_did: string;
  enabled: boolean;
  desired_revision: string;
  queue_id: string;
  queue_revision: string;
  queue_timeout_ms: number;
}
export interface InboundPolicy {
  trustedCidrs: string;
  preAdmission: number;
  trunk: number;
  waitSeconds: number;
}
const templateRoot = new URL("../../../../infra/freeswitch/templates/inbound/", import.meta.url);
export const deniedInboundXml =
  '<include><extension name="d02_disabled"><condition><action application="respond" data="503 Admission unavailable"/><action application="hangup" data="NORMAL_TEMPORARY_FAILURE"/></condition></extension></include>\n';

export function inboundPolicy(config: AppConfig): InboundPolicy {
  return {
    trustedCidrs: config.FREESWITCH_INBOUND_TRUSTED_CIDRS,
    preAdmission: config.FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT,
    trunk: config.FREESWITCH_TRUNK_CHANNEL_LIMIT,
    waitSeconds: config.FREESWITCH_INBOUND_WAIT_SECONDS
  };
}

export function validateInboundPolicy(policy: InboundPolicy): string[] {
  for (const [value, min, max] of [
    [policy.preAdmission, 1, 16],
    [policy.trunk, 2, 80],
    [policy.waitSeconds, 1, 3]
  ]) {
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error("Invalid inbound capacity/wait policy");
  }
  const cidrs = policy.trustedCidrs
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!cidrs.length || cidrs.length > 32)
    throw new Error("Configure 1–32 trusted transport CIDRs before applying inbound routes");
  for (const cidr of cidrs) {
    const parts = cidr.split("/");
    const family = isIP(parts[0]);
    const bits = Number(parts[1]);
    if (
      parts.length !== 2 ||
      !family ||
      !/^\d+$/.test(parts[1]) ||
      bits < 1 ||
      bits > (family === 4 ? 32 : 128)
    ) {
      throw new Error("Invalid trusted transport CIDR (catch-all networks are forbidden)");
    }
  }
  return [...new Set(cidrs)].sort();
}

export async function renderInboundConfiguration(routes: InboundRoute[], policy: InboundPolicy) {
  const cidrs = validateInboundPolicy(policy);
  if (routes.length > 200) throw new Error("Inbound route count exceeds 200");
  const ordered = [...routes].sort((a, b) => a.id.localeCompare(b.id));
  const dids = new Set<string>();
  for (const route of ordered) {
    if (
      !/^[0-9a-f-]{36}$/.test(route.id) ||
      !/^[0-9a-f-]{36}$/.test(route.queue_id) ||
      !/^\+[1-9][0-9]{6,14}$/.test(route.normalized_did) ||
      !/^[1-9][0-9]*$/.test(route.desired_revision) ||
      !/^[1-9][0-9]*$/.test(route.queue_revision) ||
      !Number.isInteger(route.queue_timeout_ms) ||
      route.queue_timeout_ms < 15000 ||
      route.queue_timeout_ms > 300000 ||
      typeof route.enabled !== "boolean" ||
      dids.has(route.normalized_did)
    )
      throw new Error("Invalid or duplicate inbound route");
    dids.add(route.normalized_did);
  }
  const [bundle, routeTemplate] = await Promise.all([
    readFile(new URL("public.xml.tpl", templateRoot), "utf8"),
    readFile(new URL("route.xml.tpl", templateRoot), "utf8")
  ]);
  // Hash includes templates and policy: a binary/policy change is a new desired revision.
  const hash = createHash("sha256")
    .update(JSON.stringify({ ordered, policy, cidrs, bundle, routeTemplate }))
    .digest("hex");
  const action = (app: string, data: string) => `    <action application="${app}" data="${data}"/>`;
  const renderedRoutes = ordered
    .map((route) => {
      const actions = route.enabled
        ? [
            action("set", "limit_ignore_transfer=true"),
            action(
              "limit",
              `hash outbound_dialer pre_admission ${policy.preAdmission} !NORMAL_TEMPORARY_FAILURE`
            ),
            action("limit", `hash outbound_dialer trunk ${policy.trunk} !NORMAL_TEMPORARY_FAILURE`),
            action("sched_hangup", `+${policy.waitSeconds} NORMAL_TEMPORARY_FAILURE`),
            action("set", `park_timeout=${policy.waitSeconds}`),
            action("set", "outbound_dialer_ingress_uuid=${uuid}"),
            action("set", `outbound_dialer_validated_did=${route.normalized_did}`),
            action("set", `outbound_dialer_route_revision=${route.desired_revision}`),
            action("set", `outbound_dialer_queue_id=${route.queue_id}`),
            action("set", `outbound_dialer_queue_revision=${route.queue_revision}`),
            // D03 owns durable capture/commit/ack and the admission continuation. No
            // answer/park/audio is safe before it exists. Do not call the A03 lab agent.
            action("respond", "503 Admission unavailable"),
            action("hangup", "NORMAL_TEMPORARY_FAILURE")
          ]
        : [action("respond", "403 DID disabled"), action("hangup", "CALL_REJECTED")];
      return routeTemplate
        .replaceAll("__ID__", route.id)
        .replaceAll("__DIGITS__", route.normalized_did.slice(1))
        .replace("__ACTIONS__", actions.join("\n"));
    })
    .join("\n");
  const xml = bundle
    .replace("__HASH__", hash)
    .replace("__TRUST__", cidrs.map((c) => `\${acl(\${network_addr} ${c})}`).join(":"))
    .replace("__ROUTES__", renderedRoutes);
  if (/__[A-Z]+__/.test(xml)) throw new Error("Unresolved inbound template placeholder");
  validateInboundXml(xml);
  return { hash, xml };
}

export function validateInboundXml(xml: string) {
  const parser = new SaxesParser();
  parser.on("doctype", () => {
    throw new Error("DOCTYPE is forbidden in inbound configuration");
  });
  parser.write(xml).close();
}

interface ApplyState {
  desired_revision: string;
  desired_hash: string | null;
  applied_hash: string | null;
  applied_xml: string | null;
}
export interface InboundApplyOptions {
  command?: (command: string) => Promise<string>;
  write?: typeof atomicConfigurationWrite;
}

export class InboundConfigurationPublisher {
  private command: (command: string) => Promise<string>;
  private write?: typeof atomicConfigurationWrite;
  constructor(
    private pool: pg.Pool,
    private config: AppConfig,
    options: InboundApplyOptions = {}
  ) {
    this.command =
      options.command ?? (async (command) => (await sendFreeSwitchApiCommand(config, command)).body.trim());
    this.write = options.write;
  }
  async reconcile(): Promise<"applied" | "busy" | "disabled" | "error"> {
    if (!this.config.FREESWITCH_INBOUND_CONFIG_ENABLED || !this.config.FREESWITCH_ESL_ENABLED)
      return "disabled";
    const client = await this.pool.connect();
    let locked = false,
      lost = false,
      changed = false;
    let state: ApplyState | undefined;
    let revision: string | undefined;
    let writer: LockedConfigurationWriter | null = null;
    const write = (path: string, value: string) =>
      this.write ? this.write(path, value) : writer!.write(path, value);
    const active = join(this.config.FREESWITCH_GENERATED_CONFIG_DIR, "dialplan", "public", "00-inbound.xml");
    const good = join(this.config.FREESWITCH_GENERATED_CONFIG_DIR, "inbound", "last-good.xml");
    const onError = () => {
      lost = true;
    };
    client.on("error", onError);
    const alive = async () => {
      if (lost) throw new Error("Configuration publisher lost its database lock connection");
      await client.query("select 1");
      if (lost) throw new Error("Configuration publisher lost its database lock connection");
    };
    const verify = async (hash: string | null) => {
      const effective = await this.command("xml_locate dialplan context name public");
      if (
        hash ? !effective.includes(`name="d02_revision_${hash}"`) : !effective.includes('name="d02_disabled"')
      )
        throw new Error("Loaded public dialplan does not match the expected bundle revision");
      const markers = [...effective.matchAll(/name="d02_revision_([0-9a-f]{64})"/g)];
      if (markers.length !== (hash ? 1 : 0)) throw new Error("Ambiguous loaded inbound configuration");
    };
    const reload = async () => {
      if (!/^\+OK\b/.test(await this.command("reloadxml"))) throw new Error("FreeSWITCH reloadxml failed");
    };
    try {
      locked = (await client.query("select pg_try_advisory_lock(72204,0) as locked")).rows[0].locked;
      if (!locked) return "busy";
      writer = await LockedConfigurationWriter.acquire(this.config.FREESWITCH_GENERATED_CONFIG_DIR);
      if (!writer) return "busy";
      state = (
        await client.query<ApplyState>("select * from inbound_freeswitch_configuration where singleton")
      ).rows[0];
      revision = state.desired_revision;
      const routes = (
        await client.query<InboundRoute>(`select n.id,n.normalized_did,n.enabled,n.desired_revision::text,n.queue_id,
        q.desired_revision::text as queue_revision,q.queue_timeout_ms from inbound_numbers n join inbound_queues q on q.id=n.queue_id order by n.id`)
      ).rows;
      const rendered = await renderInboundConfiguration(routes, inboundPolicy(this.config));
      if (state.desired_hash !== rendered.hash) {
        revision = (
          await client.query(
            "update inbound_freeswitch_configuration set desired_revision=desired_revision+1,desired_hash=$1,verified_at=null returning desired_revision::text",
            [rendered.hash]
          )
        ).rows[0].desired_revision;
      }
      await alive();
      // Reapply even an unchanged revision: API/FS restart and manual disk drift
      // must be reconciled against actual loaded XML, not a previous SQL success.
      changed = true;
      await write(active, rendered.xml);
      await alive();
      await reload();
      await verify(rendered.hash);
      await alive();
      await write(good, rendered.xml);
      await client.query("begin");
      try {
        const updated = await client.query(
          `update inbound_freeswitch_configuration set applied_revision=$1,applied_hash=$2,applied_xml=$3,
          verified_at=clock_timestamp(),apply_error=null,error_revision=null where singleton and desired_revision=$1`,
          [revision, rendered.hash, rendered.xml]
        );
        if (updated.rowCount !== 1) throw new Error("Desired configuration changed before completion");
        await client.query("update inbound_numbers set applied_revision=desired_revision");
        await client.query("update inbound_queues set applied_revision=desired_revision");
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      return "applied";
    } catch (error) {
      let rollbackFailed = false;
      if (changed && !lost && state) {
        try {
          await alive();
          await write(active, state.applied_xml ?? deniedInboundXml);
          await reload();
          await verify(state.applied_hash);
          await write(good, state.applied_xml ?? deniedInboundXml);
        } catch {
          rollbackFailed = true;
        }
      }
      if (locked && !lost)
        await client.query(
          `update inbound_freeswitch_configuration set verified_at=null,error_revision=$1,apply_error=$2 where singleton`,
          [
            revision ?? state?.desired_revision ?? null,
            `${error instanceof Error ? error.message : "Inbound configuration apply failed"}${rollbackFailed ? "; last-good rollback not verified; routing is uncertain" : ""}`.slice(
              0,
              1000
            )
          ]
        );
      return "error";
    } finally {
      await writer?.close();
      client.removeListener("error", onError);
      if (locked && !lost) {
        try {
          await client.query("select pg_advisory_unlock(72204,0)");
        } catch {
          lost = true;
        }
      }
      client.release(lost);
    }
  }
}
