import { basename, extname } from "node:path";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type pg from "pg";
import type { AdminOverviewResponse, AdminRecordingListResponse } from "@outbound-dialer/shared";

export type RecordingExtension = ".mp3" | ".wav";

export type RecordingLibraryFilters = {
  page: number;
  pageSize: number;
  q?: string;
};

const execFileAsync = promisify(execFile);
const maximumRecordingDurationSeconds = 5 * 60;

export class RecordingProcessingError extends Error {
  constructor(
    message: string,
    readonly code: "processor_unavailable" | "invalid_audio" | "too_long"
  ) {
    super(message);
    this.name = "RecordingProcessingError";
  }
}

export async function transcodeRecordingToCanonicalWav(
  inputPath: string,
  outputPath: string,
  options: { ffmpegPath?: string; ffprobePath?: string } = {}
): Promise<{ durationSeconds: number; fileSizeBytes: number }> {
  const ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const probe = await probeRecording(inputPath, ffprobePath);
  if (probe.durationSeconds > maximumRecordingDurationSeconds) {
    throw new RecordingProcessingError("Recording must be 5 minutes or shorter", "too_long");
  }

  try {
    await execFileAsync(ffmpegPath, buildCanonicalTranscodeArgs(inputPath, outputPath), {
      maxBuffer: 2_000_000
    });
  } catch (error) {
    throw mapProcessorError(error, "Could not decode and transcode this audio file");
  }

  const canonicalProbe = await probeRecording(outputPath, ffprobePath);
  const file = await stat(outputPath);
  if (!file.isFile() || file.size === 0) {
    throw new RecordingProcessingError("The transcoded audio file is empty", "invalid_audio");
  }
  return {
    durationSeconds: Math.max(1, Math.round(canonicalProbe.durationSeconds)),
    fileSizeBytes: file.size
  };
}

export function buildCanonicalTranscodeArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-c:a",
    "pcm_s16le",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    outputPath
  ];
}

export function parseProbeOutput(value: string): { durationSeconds: number; hasAudio: boolean } {
  let parsed: { format?: { duration?: string | number }; streams?: Array<{ codec_type?: string }> };
  try {
    parsed = JSON.parse(value) as typeof parsed;
  } catch {
    throw new RecordingProcessingError("Audio metadata could not be read", "invalid_audio");
  }
  const durationSeconds = Number(parsed.format?.duration ?? 0);
  const hasAudio = parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  if (!hasAudio || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RecordingProcessingError("File does not contain a supported audio stream", "invalid_audio");
  }
  return { durationSeconds, hasAudio };
}

export function parseSingleByteRange(
  value: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!value) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    return null;
  }

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

export async function probeRecording(
  inputPath: string,
  ffprobePath: string
): Promise<{ durationSeconds: number; hasAudio: boolean }> {
  try {
    const result = await execFileAsync(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", inputPath],
      { maxBuffer: 1_000_000 }
    );
    return parseProbeOutput(result.stdout);
  } catch (error) {
    if (error instanceof RecordingProcessingError) {
      throw error;
    }
    throw mapProcessorError(error, "Could not decode this audio file");
  }
}

function mapProcessorError(error: unknown, fallback: string): RecordingProcessingError {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return new RecordingProcessingError("Audio processing service is unavailable", "processor_unavailable");
  }
  return new RecordingProcessingError(fallback, "invalid_audio");
}

export async function getRecordings(pool: pg.Pool): Promise<AdminOverviewResponse["recordings"]> {
  return (await queryRecordingLibrary(pool, { limit: null, offset: 0 })).items;
}

export async function getRecordingsPage(
  pool: pg.Pool,
  filters: RecordingLibraryFilters
): Promise<AdminRecordingListResponse> {
  const result = await queryRecordingLibrary(pool, {
    q: filters.q,
    limit: filters.pageSize,
    offset: (filters.page - 1) * filters.pageSize
  });
  return {
    items: result.items,
    page: filters.page,
    pageSize: filters.pageSize,
    total: result.total,
    totalPages: result.total ? Math.ceil(result.total / filters.pageSize) : 0
  };
}

async function queryRecordingLibrary(
  pool: pg.Pool,
  filters: { q?: string; limit: number | null; offset: number }
): Promise<{ items: AdminOverviewResponse["recordings"]; total: number }> {
  const q = filters.q?.trim() || null;
  const result = await pool.query<RecordingRow & { total_count: string }>(
    `
    select id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
      , count(*) over() as total_count
    from recordings
    where is_active = true
      and ($1::text is null or name ilike '%' || $1 || '%')
    order by is_default desc, created_at desc
    limit $2 offset $3
  `,
    [q, filters.limit, filters.offset]
  );

  return {
    items: result.rows.map(mapRecordingRow),
    total: Number(result.rows[0]?.total_count ?? 0)
  };
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
    await lockDefaultRecordingSelection(client);
    const currentDefault = await client.query(
      "select 1 from recordings where is_active = true and is_default = true limit 1"
    );
    const shouldMakeDefault = input.makeDefault || !currentDefault.rowCount;

    if (shouldMakeDefault) {
      await client.query("update recordings set is_default = false, updated_at = now()");
    }

    const result = await client.query<RecordingRow>(
      `
        insert into recordings (name, file_path, runtime_file_path, is_default, is_active, duration_seconds, file_size_bytes)
        values ($1, $2, $3, $4, true, $5, $6)
        returning id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
      `,
      [
        input.name,
        input.filePath,
        input.runtimeFilePath,
        shouldMakeDefault,
        input.durationSeconds,
        input.fileSizeBytes
      ]
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
    await lockDefaultRecordingSelection(client);
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

export type DeleteRecordingResult =
  { status: "deleted"; filePath: string } | { status: "in_use" } | { status: "not_found" };

export async function deleteRecording(pool: pg.Pool, recordingId: string): Promise<DeleteRecordingResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockDefaultRecordingSelection(client);
    const existing = await client.query<{ id: string; file_path: string; is_default: boolean }>(
      "select id, file_path, is_default from recordings where id = $1 and is_active = true",
      [recordingId]
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query("rollback");
      return { status: "not_found" };
    }

    const activeReference = await client.query(
      `
        select 1
        from calls
        where recording_id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled')
        limit 1
      `,
      [recordingId]
    );
    if (activeReference.rowCount) {
      await client.query("rollback");
      return { status: "in_use" };
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
    return { status: "deleted", filePath: row.file_path };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreDeletedRecording(pool: pg.Pool, recordingId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockDefaultRecordingSelection(client);
    const restored = await client.query(
      `
        update recordings
        set is_active = true,
            updated_at = now()
        where id = $1
          and is_active = false
        returning id
      `,
      [recordingId]
    );
    if (restored.rowCount) {
      await client.query(
        `
          update recordings
          set is_default = true,
              updated_at = now()
          where id = $1
            and not exists (
              select 1
              from recordings current_default
              where current_default.is_active = true
                and current_default.is_default = true
            )
        `,
        [recordingId]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockDefaultRecordingSelection(client: pg.PoolClient): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext('outbound-dialer-default-recording'))");
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
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
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
    ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
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

  if (
    versionBits === 1 ||
    layerBits === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return null;
  }

  const version: "mpeg1" | "mpeg2" | "mpeg25" =
    versionBits === 3 ? "mpeg1" : versionBits === 2 ? "mpeg2" : "mpeg25";
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
