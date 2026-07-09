import { basename, extname } from "node:path";
import type pg from "pg";
import type { AdminOverviewResponse } from "@outbound-dialer/shared";

export type RecordingExtension = ".mp3" | ".wav";

export async function getRecordings(pool: pg.Pool): Promise<AdminOverviewResponse["recordings"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    runtime_file_path: string;
    duration_seconds: number;
    file_size_bytes: number;
    is_default: boolean;
    is_active: boolean;
  }>(`
    select id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
    from recordings
    where is_active = true
    order by is_default desc, created_at desc
    limit 12
  `);

  return result.rows.map(mapRecordingRow);
}

export async function createRecording(
  pool: pg.Pool,
  input: {
    name: string;
    filePath: string;
    runtimeFilePath: string;
    durationSeconds: number;
    fileSizeBytes: number;
    makeDefault: boolean;
  }
): Promise<AdminOverviewResponse["recordings"][number]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const countResult = await client.query<{ count: string }>("select count(*) from recordings");
    const shouldMakeDefault = input.makeDefault || Number(countResult.rows[0]?.count ?? 0) === 0;

    if (shouldMakeDefault) {
      await client.query("update recordings set is_default = false, updated_at = now()");
    }

    const result = await client.query<RecordingRow>(
      `
        insert into recordings (name, file_path, runtime_file_path, is_default, is_active, duration_seconds, file_size_bytes)
        values ($1, $2, $3, $4, true, $5, $6)
        returning id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
      `,
      [input.name, input.filePath, input.runtimeFilePath, shouldMakeDefault, input.durationSeconds, input.fileSizeBytes]
    );
    await client.query("commit");
    return mapRecordingRow(result.rows[0]);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function setDefaultRecording(
  pool: pg.Pool,
  recordingId: string
): Promise<AdminOverviewResponse["recordings"][number] | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const exists = await client.query<{ id: string }>(
      "select id from recordings where id = $1 and is_active = true",
      [recordingId]
    );
    if (!exists.rowCount) {
      await client.query("rollback");
      return null;
    }

    await client.query("update recordings set is_default = false, updated_at = now()");
    const result = await client.query<RecordingRow>(
      `
        update recordings
        set is_default = true, updated_at = now()
        where id = $1
        returning id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
      `,
      [recordingId]
    );
    await client.query("commit");
    return mapRecordingRow(result.rows[0]);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteRecording(pool: pg.Pool, recordingId: string): Promise<{ filePath: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string; file_path: string; is_default: boolean }>(
      "select id, file_path, is_default from recordings where id = $1 and is_active = true",
      [recordingId]
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query("rollback");
      return null;
    }

    await client.query(
      `
        update recordings
        set is_active = false, is_default = false, updated_at = now()
        where id = $1
      `,
      [recordingId]
    );

    if (row.is_default) {
      await client.query(
        `
          update recordings
          set is_default = true, updated_at = now()
          where id = (
            select id
            from recordings
            where is_active = true
            order by created_at desc
            limit 1
          )
        `
      );
    }

    await client.query("commit");
    return { filePath: row.file_path };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getRecordingAudioFile(
  pool: pg.Pool,
  recordingId: string
): Promise<{ filePath: string; filename: string } | null> {
  const result = await pool.query<{ file_path: string; name: string }>(
    `
      select file_path, name
      from recordings
      where id = $1 and is_active = true
    `,
    [recordingId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    filePath: row.file_path,
    filename: sanitizeDownloadFilename(row.name, extname(row.file_path))
  };
}

type RecordingRow = {
  id: string;
  name: string;
  runtime_file_path: string;
  duration_seconds: number;
  file_size_bytes: number;
  is_default: boolean;
  is_active: boolean;
};

function mapRecordingRow(row: RecordingRow): AdminOverviewResponse["recordings"][number] {
  return {
    id: row.id,
    name: row.name,
    durationSeconds: row.duration_seconds,
    fileSizeBytes: row.file_size_bytes,
    runtimeFilePath: row.runtime_file_path,
    status: row.is_default ? "default" : row.is_active ? "ready" : "inactive"
  };
}

export function getSupportedRecordingExtension(filename: string): RecordingExtension | null {
  const extension = extname(filename).toLowerCase();
  return extension === ".mp3" || extension === ".wav" ? extension : null;
}

export function normalizeRecordingName(value: string | undefined, filename: string): string {
  const rawName = value?.trim() || basename(filename, extname(filename));
  return rawName.replace(/\s+/g, " ").slice(0, 160) || "Voicemail recording";
}

export function getMultipartFieldValue(field: unknown): string | undefined {
  if (Array.isArray(field)) {
    return getMultipartFieldValue(field[0]);
  }
  if (field && typeof field === "object" && "value" in field && typeof field.value === "string") {
    return field.value;
  }
  return undefined;
}

export function parseBooleanField(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "on";
}

export function getRecordingContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".mp3") {
    return "audio/mpeg";
  }
  if (extension === ".wav") {
    return "audio/wav";
  }
  return "application/octet-stream";
}

function sanitizeDownloadFilename(name: string, extension: string): string {
  const safeName = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safeName || "voicemail"}${extension}`;
}

export function detectAudioDurationSeconds(buffer: Buffer, extension: RecordingExtension): number {
  const duration = extension === ".wav" ? detectWavDurationSeconds(buffer) : detectMp3DurationSeconds(buffer);
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(duration));
}

function detectWavDurationSeconds(buffer: Buffer): number {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return 0;
  }

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkDataOffset + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(chunkDataOffset + 8);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : 0;
}

function detectMp3DurationSeconds(buffer: Buffer): number {
  let offset = getMp3AudioStartOffset(buffer);
  let duration = 0;
  let frames = 0;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const frame = parseMp3FrameHeader(buffer, offset);
    if (!frame) {
      offset += 1;
      continue;
    }

    duration += frame.samplesPerFrame / frame.sampleRate;
    frames += 1;
    offset += frame.frameLength;
  }

  return frames > 0 ? duration : 0;
}

function getMp3AudioStartOffset(buffer: Buffer): number {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "ID3") {
    return 0;
  }
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);
  return 10 + size;
}

function parseMp3FrameHeader(
  buffer: Buffer,
  offset: number
): { frameLength: number; sampleRate: number; samplesPerFrame: number } | null {
  const versionBits = (buffer[offset + 1] >> 3) & 0x03;
  const layerBits = (buffer[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  const padding = (buffer[offset + 2] >> 1) & 0x01;

  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }

  const version: "mpeg1" | "mpeg2" | "mpeg25" = versionBits === 3 ? "mpeg1" : versionBits === 2 ? "mpeg2" : "mpeg25";
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const sampleRate = getMp3SampleRate(version, sampleRateIndex);
  const bitrate = getMp3Bitrate(version, layer, bitrateIndex);
  if (!sampleRate || !bitrate) {
    return null;
  }

  if (layer === 1) {
    return {
      frameLength: Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4,
      sampleRate,
      samplesPerFrame: 384
    };
  }

  const samplesPerFrame = layer === 3 && version !== "mpeg1" ? 576 : 1152;
  const coefficient = layer === 3 && version !== "mpeg1" ? 72 : 144;
  return {
    frameLength: Math.floor((coefficient * bitrate * 1000) / sampleRate + padding),
    sampleRate,
    samplesPerFrame
  };
}

function getMp3SampleRate(version: "mpeg1" | "mpeg2" | "mpeg25", index: number): number {
  const rates = {
    mpeg1: [44100, 48000, 32000],
    mpeg2: [22050, 24000, 16000],
    mpeg25: [11025, 12000, 8000]
  };
  return rates[version][index] ?? 0;
}

function getMp3Bitrate(version: "mpeg1" | "mpeg2" | "mpeg25", layer: 1 | 2 | 3, index: number): number {
  const mpeg1 = {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  };
  const mpeg2 = {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  };
  return (version === "mpeg1" ? mpeg1[layer] : mpeg2[layer])[index] ?? 0;
}
