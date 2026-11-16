import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import type { AppConfig } from "./config.js";
import {
  InboundConfigurationPublisher,
  atomicConfigurationWrite,
  deniedInboundXml
} from "./freeswitch/inbound-config.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture() {
  const schema = `d02_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
  await admin.query(`create schema ${schema}`);
  await runMigrations(pool);
  const directory = await mkdtemp("/tmp/d02-config-");
  const config = {
    FREESWITCH_ESL_ENABLED: true,
    FREESWITCH_INBOUND_CONFIG_ENABLED: true,
    FREESWITCH_GENERATED_CONFIG_DIR: directory,
    FREESWITCH_INBOUND_TRUSTED_CIDRS: "127.0.0.2/32",
    FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT: 8,
    FREESWITCH_TRUNK_CHANNEL_LIMIT: 40,
    FREESWITCH_INBOUND_WAIT_SECONDS: 3
  } as AppConfig;
  const campaign = (await pool.query("insert into campaigns(name) values('D02') returning id")).rows[0].id;
  const queue = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'D02') returning id", [campaign])
  ).rows[0].id;
  const number = (
    await pool.query(
      "insert into inbound_numbers(normalized_did,label,queue_id,enabled) values('+12025550100','D02',$1,true) returning id",
      [queue]
    )
  ).rows[0].id;
  const active = join(directory, "dialplan/public/00-inbound.xml");
  await atomicConfigurationWrite(active, deniedInboundXml);
  let loaded = deniedInboundXml;
  const commands: string[] = [];
  let failReload = 0,
    failVerify = 0;
  const command = async (cmd: string) => {
    commands.push(cmd);
    if (cmd === "reloadxml") {
      if (failReload-- > 0) return "-ERR reload failed";
      loaded = await readFile(active, "utf8");
      return "+OK [Success]";
    }
    if (failVerify-- > 0) return '<context name="public"/>';
    return loaded;
  };
  return {
    pool,
    config,
    active,
    number,
    queue,
    command,
    commands,
    publisher: () => new InboundConfigurationPublisher(pool, config, { command }),
    loaded: () => loaded,
    failReload: () => {
      failReload = 1;
    },
    failVerify: () => {
      failVerify = 1;
    },
    state: async () => (await pool.query("select * from inbound_freeswitch_configuration")).rows[0],
    async cleanup() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test(
  "D02.2 DB: two publishers serialize; edits wait before row locks and only latest desired revision is applied",
  options,
  async () => {
    const f = await fixture();
    const gate = deferred(),
      resume = deferred();
    let work: Promise<unknown> | undefined;
    try {
      let held = false;
      const first = new InboundConfigurationPublisher(f.pool, f.config, {
        command: async (cmd) => {
          if (cmd === "reloadxml" && !held) {
            held = true;
            gate.resolve();
            await resume.promise;
          }
          return f.command(cmd);
        }
      });
      work = first.reconcile();
      await gate.promise;
      assert.equal(await f.publisher().reconcile(), "busy");
      const edit = await f.pool.connect();
      try {
        const applier = (
          await f.pool.query(
            "select pid from pg_locks where locktype='advisory' and classid=72204 and objid=0 and granted"
          )
        ).rows[0].pid;
        const editPid = (await edit.query("select pg_backend_pid() as pid")).rows[0].pid;
        const editing = edit.query("update inbound_numbers set enabled=false where id=$1", [f.number]);
        await assertBlocked(f.pool, editPid, applier);
        resume.resolve();
        assert.equal(await work, "applied");
        await editing;
        assert.notEqual((await f.state()).desired_revision, (await f.state()).applied_revision);
        assert.equal(await f.publisher().reconcile(), "applied");
        const state = await f.state();
        assert.equal(state.applied_revision, state.desired_revision);
        assert.match(f.loaded(), /403 DID disabled/);
        assert.equal(
          (await f.pool.query("select applied_revision=desired_revision as applied from inbound_numbers"))
            .rows[0].applied,
          true
        );
      } finally {
        edit.release();
      }
    } finally {
      resume.resolve();
      await work;
      await f.cleanup();
    }
  }
);

test(
  "D02.2 DB: edit committed first or rolled back is revalidated; older snapshots cannot overwrite latest settings",
  options,
  async () => {
    const f = await fixture();
    try {
      for (const rollback of [false, true]) {
        const edit = await f.pool.connect();
        await edit.query("begin");
        await edit.query("update inbound_numbers set enabled=false");
        assert.equal(await f.publisher().reconcile(), "busy");
        await edit.query(rollback ? "rollback" : "commit");
        edit.release();
        assert.equal(await f.publisher().reconcile(), "applied");
        const state = await f.state();
        assert.equal(state.applied_revision, state.desired_revision);
        assert.match(f.loaded(), rollback ? /503 Admission unavailable/ : /403 DID disabled/);
        await f.pool.query("update inbound_numbers set enabled=true");
      }
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "D02.2 DB: invalid render, write, reload and loaded-revision failure preserve last-good; failures remain actionable",
  options,
  async () => {
    const f = await fixture();
    try {
      assert.equal(await f.publisher().reconcile(), "applied");
      const before = await f.state();
      await f.pool.query("update inbound_numbers set enabled=false");
      for (const fault of ["render", "write", "reload", "verify"]) {
        f.config.FREESWITCH_INBOUND_TRUSTED_CIDRS = fault === "render" ? "0.0.0.0/0" : "127.0.0.2/32";
        if (fault === "reload") f.failReload();
        if (fault === "verify") f.failVerify();
        let failed = false;
        const publisher = new InboundConfigurationPublisher(f.pool, f.config, {
          command: f.command,
          write: async (path, xml) => {
            if (fault === "write" && !failed) {
              failed = true;
              throw new Error("injected EACCES");
            }
            await atomicConfigurationWrite(path, xml);
          }
        });
        assert.equal(await publisher.reconcile(), "error", fault);
        const state = await f.state();
        assert.equal(state.applied_hash, before.applied_hash);
        assert.ok(state.apply_error);
        assert.equal(state.verified_at, null);
        assert.equal(await readFile(f.active, "utf8"), before.applied_xml);
        assert.equal(f.loaded(), before.applied_xml);
      }
      assert.equal(await f.publisher().reconcile(), "applied");
      assert.equal((await f.state()).apply_error, null);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "D02.3 DB: API restart/policy change and disk drift reconcile actual XML; feature-off sends nothing",
  options,
  async () => {
    const f = await fixture();
    try {
      f.config.FREESWITCH_INBOUND_CONFIG_ENABLED = false;
      assert.equal(await f.publisher().reconcile(), "disabled");
      assert.equal(f.commands.length, 0);
      f.config.FREESWITCH_INBOUND_CONFIG_ENABLED = true;
      assert.equal(await f.publisher().reconcile(), "applied");
      const before = await f.state();
      await atomicConfigurationWrite(f.active, "<include/>");
      assert.equal(await f.publisher().reconcile(), "applied");
      assert.equal(await readFile(f.active, "utf8"), before.applied_xml);
      f.config.FREESWITCH_TRUNK_CHANNEL_LIMIT = 39;
      assert.equal(await f.publisher().reconcile(), "applied");
      const state = await f.state();
      assert.notEqual(before.applied_hash, state.applied_hash);
      assert.ok(BigInt(state.applied_revision) > BigInt(before.applied_revision));
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "D02 migration 034 upgrades populated 033 without enabling routes or rewriting previous checksums",
  options,
  async () => {
    const f = await fixture();
    try {
      const history = (
        await f.pool.query(
          "select * from schema_migrations where filename<'034_freeswitch_configuration.sql' order by filename"
        )
      ).rows;
      await f.pool
        .query(`drop trigger inbound_numbers_fs_lock on inbound_numbers;drop trigger inbound_queues_fs_lock on inbound_queues;
      drop trigger inbound_numbers_fs_changed on inbound_numbers;drop trigger inbound_queues_fs_changed on inbound_queues;
      drop table inbound_freeswitch_configuration;drop function inbound_fs_configuration_lock();drop function inbound_fs_configuration_changed();
      delete from schema_migrations where filename='034_freeswitch_configuration.sql'`);
      const numbers = (await f.pool.query("select * from inbound_numbers")).rows;
      await runMigrations(f.pool);
      await runMigrations(f.pool);
      assert.deepEqual((await f.pool.query("select * from inbound_numbers")).rows, numbers);
      assert.equal((await f.state()).applied_revision, null);
      assert.deepEqual(
        (
          await f.pool.query(
            "select * from schema_migrations where filename<'034_freeswitch_configuration.sql' order by filename"
          )
        ).rows,
        history
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "D02.2 DB: lost database lock during a suspended write cannot overwrite a replacement; OS writer lock is never stolen by TTL",
  options,
  async () => {
    const f = await fixture();
    const gate = deferred(),
      resume = deferred();
    let work: Promise<unknown> | undefined;
    try {
      assert.equal(await f.publisher().reconcile(), "applied");
      const before = await f.state();
      await f.pool.query("update inbound_numbers set enabled=false");
      let held = false;
      const stale = new InboundConfigurationPublisher(f.pool, f.config, {
        command: f.command,
        write: async (path, xml) => {
          if (path === f.active && !held) {
            held = true;
            gate.resolve();
            await resume.promise;
          }
          await atomicConfigurationWrite(path, xml);
        }
      });
      work = stale.reconcile();
      await gate.promise;
      const backend = (
        await f.pool.query(
          "select pid from pg_locks where locktype='advisory' and classid=72204 and objid=0 and granted"
        )
      ).rows[0].pid;
      assert.equal(
        (await f.pool.query("select pg_terminate_backend($1) as stopped", [backend])).rows[0].stopped,
        true
      );
      // Committing a newer desired revision proves the old DB lock is gone.
      await f.pool.query("update inbound_numbers set enabled=true");
      assert.equal(await f.publisher().reconcile(), "busy");
      assert.equal((await f.state()).applied_hash, before.applied_hash);
      resume.resolve();
      assert.equal(await work, "error");
      assert.equal((await f.state()).applied_hash, before.applied_hash);
      assert.equal(await f.publisher().reconcile(), "applied");
      const state = await f.state();
      assert.equal(state.desired_revision, state.applied_revision);
      assert.match(f.loaded(), /503 Admission unavailable/);
      assert.doesNotMatch(f.loaded(), /403 DID disabled/);
      assert.equal(await readFile(f.active, "utf8"), state.applied_xml);
    } finally {
      resume.resolve();
      await work;
      await f.cleanup();
    }
  }
);
