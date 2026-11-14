import assert from "node:assert/strict";
import test from "node:test";
import { encodeUlaw, decodeUlaw, assertTone, decodeWav } from "../scripts/a05-media.mjs";

test("A05 media assertions distinguish decoded conversation tones from silence, wrong tones and noise", () => {
  const tone = (frequency) =>
    Array.from({ length: 3200 }, (_, i) =>
      decodeUlaw(encodeUlaw(6000 * Math.sin((2 * Math.PI * frequency * i) / 8000)))
    );
  for (const frequency of [440, 660, 880]) assertTone(tone(frequency), frequency);
  assert.throws(() => assertTone(tone(660), 880), /Missing 880Hz/);
  assert.throws(() => assertTone(Array(3200).fill(0), 440), /Missing 440Hz/);
  assert.throws(() => assertTone(tone(440).slice(0, 160), 440), /Less than 200 ms/);
  let seed = 12345;
  const noise = Array.from({ length: 3200 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 12000;
  });
  assert.throws(() => assertTone(noise, 440), /Missing 440Hz/);
});

test("A05 recording decoder preserves stereo sides and rejects invalid or compressed evidence", () => {
  const wav = Buffer.alloc(52);
  wav.write("RIFF");
  wav.writeUInt32LE(44, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(8, 40);
  wav.writeInt16LE(-3000, 44);
  wav.writeInt16LE(5000, 46);
  wav.writeInt16LE(2000, 48);
  wav.writeInt16LE(-4000, 50);
  assert.deepEqual(decodeWav(wav), {
    channels: 2,
    samples: [
      [-3000, 5000],
      [2000, -4000]
    ]
  });
  wav.writeUInt16LE(7, 20);
  assert.throws(() => decodeWav(wav), /Expected decoded PCM WAV/);
  assert.throws(() => decodeWav(Buffer.from("not a recording")));
});

test("A05 PCMU encoding retains sign and amplitude over the fixture signal range", () => {
  assert.equal(decodeUlaw(255), 0);
  for (const sample of [-6000, -3000, -1000, 1000, 3000, 6000]) {
    const decoded = decodeUlaw(encodeUlaw(sample));
    assert.equal(Math.sign(decoded), Math.sign(sample));
    assert.ok(Math.abs(decoded - sample) < 200);
  }
});
