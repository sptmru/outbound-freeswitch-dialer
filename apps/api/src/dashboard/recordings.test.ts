import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectAudioDurationSeconds,
  getMultipartFieldValue,
  getRecordingContentType,
  getSupportedRecordingExtension,
  normalizeRecordingName,
  parseBooleanField
} from "./recordings.js";

describe("recording helpers", () => {
  it("accepts supported recording extensions case-insensitively", () => {
    assert.equal(getSupportedRecordingExtension("greeting.MP3"), ".mp3");
    assert.equal(getSupportedRecordingExtension("voicemail.wav"), ".wav");
    assert.equal(getSupportedRecordingExtension("notes.txt"), null);
  });

  it("normalizes recording names from fields or filenames", () => {
    assert.equal(normalizeRecordingName("  Sales   voicemail  ", "ignored.wav"), "Sales voicemail");
    assert.equal(normalizeRecordingName(undefined, "default-message.mp3"), "default-message");
    assert.equal(normalizeRecordingName("   ", ""), "Voicemail recording");
  });

  it("reads multipart field values and boolean flags", () => {
    assert.equal(getMultipartFieldValue([{ value: "Primary" }]), "Primary");
    assert.equal(getMultipartFieldValue({ value: 1 }), undefined);
    assert.equal(parseBooleanField("on"), true);
    assert.equal(parseBooleanField("false"), false);
  });

  it("maps recording content types by extension", () => {
    assert.equal(getRecordingContentType("/tmp/voice.mp3"), "audio/mpeg");
    assert.equal(getRecordingContentType("/tmp/voice.wav"), "audio/wav");
    assert.equal(getRecordingContentType("/tmp/voice.bin"), "application/octet-stream");
  });

  it("detects PCM WAV duration from RIFF headers", () => {
    assert.equal(detectAudioDurationSeconds(createWavHeader({ seconds: 2 }), ".wav"), 2);
    assert.equal(detectAudioDurationSeconds(Buffer.from("not audio"), ".wav"), 0);
  });
});

function createWavHeader(input: { seconds: number }): Buffer {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = byteRate * input.seconds;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return header;
}
