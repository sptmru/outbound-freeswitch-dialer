import { runCallRecordingFinalization } from "../apps/api/dist-test/call-recording-finalizer.js";
// Customer recorder assertions shared by isolated G02/F04 real SIP/RTP labs.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { decodeWav, power, until } from "./a05-media.mjs";

export async function recordingProbe({ pool, callId, customerUuid, command }) {
  if (process.env.H02_RECORDINGS !== "1") return null;
  const row = await until(
    async () => {
      const c = (await pool.query("select * from calls where id=$1", [callId])).rows[0];
      return c?.call_recording_path && c.call_recording_status === "recording" ? c : null;
    },
    "H02 product recorder started",
    10000
  );
  const path = row.call_recording_path;
  const markers = [];
  async function oneRecorder() {
    const bugs = await command(`uuid_buglist ${customerUuid}`);
    assert.equal((bugs.match(/<function>session_record<\/function>/g) ?? []).length, 1, bugs);
    const starts = (
      await pool.query(
        "select customer_leg_uuid from call_events where call_id=$1 and event_type='call_recording_started'",
        [callId]
      )
    ).rows;
    assert.deepEqual(starts, [{ customer_leg_uuid: customerUuid }]);
    assert.equal(
      (await pool.query("select call_recording_path from calls where id=$1", [callId])).rows[0]
        .call_recording_path,
      path
    );
  }
  return {
    async mark(name, tones) {
      await oneRecorder();
      const before = (await stat(path)).size;
      // Wait for fresh flushed PCM, independent of arbitrary scheduler sleeps.
      const size = await until(
        async () => {
          const n = (await stat(path)).size;
          return n >= before + 16000 ? n : null;
        },
        `H02 fresh recording bytes ${name}`,
        8000
      );
      markers.push({ name, tones, endByte: size });
    },
    async finish() {
      await until(
        async () =>
          (
            await pool.query("select ended_at from call_legs where call_id=$1 and type='customer'", [callId])
          ).rows.every((l) => l.ended_at),
        "H02 customer cleanup",
        10000
      );
      const bytes = await readFile(path);
      const wav = decodeWav(bytes);
      const dataOffset = bytes.length - wav.samples.length * wav.channels * 2;
      const measured = markers.map((marker) => {
        const end = Math.min(
          wav.samples.length,
          Math.floor((marker.endByte - dataOffset) / (wav.channels * 2))
        );
        assert.ok(end >= 1600);
        return {
          ...marker,
          levels: marker.tones.map((frequency) => {
            let peak = 0;
            for (let channel = 0; channel < wav.channels; channel++)
              peak = Math.max(
                peak,
                power(
                  wav.samples.slice(end - 1600, end).map((s) => s[channel]),
                  frequency
                )
              );
            assert.ok(peak > 500, `${marker.name}: missing ${frequency}Hz (${peak})`);
            return { frequency, peak };
          })
        };
      });
      assert.ok(wav.samples.length >= 8000, "H02 recording duration below one second");
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from call_events where call_id=$1 and event_type='call_recording_started'",
            [callId]
          )
        ).rows[0].n,
        1
      );
      await runCallRecordingFinalization(pool, process.env.FFPROBE_PATH ?? "ffprobe", {
        terminalGraceSeconds: 0
      });
      const finalized = (
        await pool.query(
          "select call_recording_status,call_recording_duration_seconds,call_recording_file_size_bytes from calls where id=$1",
          [callId]
        )
      ).rows[0];
      assert.equal(finalized.call_recording_status, "available");
      await runCallRecordingFinalization(pool, process.env.FFPROBE_PATH ?? "ffprobe", {
        terminalGraceSeconds: 0
      });
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from call_events where call_id=$1 and event_type='call_recording_finalized'",
            [callId]
          )
        ).rows[0].n,
        1
      );
      return {
        finalized,
        callId,
        customerUuid,
        path,
        channels: wav.channels,
        durationSeconds: wav.samples.length / 8000,
        markers: measured,
        manualListening: "pending human verification; automated PCM marker analysis only"
      };
    }
  };
}
