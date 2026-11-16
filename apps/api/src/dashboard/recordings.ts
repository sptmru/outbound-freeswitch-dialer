import { ADMISSION_LOCK_NAMESPACE } from "../call-admission.js";
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
  campaignId?: string;
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
      maxBuffer: 2_000_000,
      timeout: 60_000
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
    "-protocol_whitelist",
    "file,pipe",
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
  let parsed: {
    format?: { duration?: string | number; format_name?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  try {
    parsed = JSON.parse(value) as typeof parsed;
  } catch {
    throw new RecordingProcessingError("Audio metadata could not be read", "invalid_audio");
  }
  const durationSeconds = Number(parsed.format?.duration ?? 0);
  const hasAudio = parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  if (parsed.format?.format_name && !["wav", "mp3"].includes(parsed.format.format_name)) {
    throw new RecordingProcessingError("Recording must contain WAV or MP3 audio", "invalid_audio");
  }
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
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_entries",
        "format=duration,format_name:stream=codec_type",
        "-of",
        "json",
        inputPath
      ],
      { maxBuffer: 1_000_000, timeout: 15_000 }
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
    campaignId: filters.campaignId,
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
  filters: { q?: string; campaignId?: string; limit: number | null; offset: number }
): Promise<{ items: AdminOverviewResponse["recordings"]; total: number }> {
  const q = filters.q?.trim() || null;
  const result = await pool.query<RecordingRow & { total_count: string }>(
    `
    select recordings.id, recordings.name, runtime_file_path, duration_seconds, file_size_bytes,
      recordings.is_active, recordings.campaign_id, campaigns.name as campaign_name,
      (campaigns.voicemail_recording_id = recordings.id) as is_assigned,
      count(*) over() as total_count
    from recordings
    join campaigns on campaigns.id = recordings.campaign_id
    where recordings.is_active = true
      and ($1::text is null or recordings.name ilike '%' || $1 || '%')
      and ($4::uuid is null or recordings.campaign_id = $4)
    order by is_assigned desc nulls last, recordings.created_at desc
    limit $2 offset $3
  `,
    [q, filters.limit, filters.offset, filters.campaignId ?? null]
  );

  return {
    items: result.rows.map(mapRecordingRow),
    total: Number(result.rows[0]?.total_count ?? 0)
  };
}

export class RecordingAssignmentError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409
  ) {
    super(message);
  }
}

// All assignment changes, deletion, and drop claims take this lock before row locks.
// It is released before any filesystem or FreeSWITCH operation.
export async function lockCampaignVoicemail(client: pg.PoolClient, campaignId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock($1,0)", [ADMISSION_LOCK_NAMESPACE]);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `outbound-dialer-campaign-voicemail:${campaignId}`
  ]);
}

async function getAssignableCampaign(client: pg.PoolClient, campaignId: string) {
  const result = await client.query<{ name: string; status: string; voicemail_recording_id: string | null }>(
    "select name, status, voicemail_recording_id from campaigns where id = $1 for update",
    [campaignId]
  );
  const campaign = result.rows[0];
  if (!campaign) throw new RecordingAssignmentError("Campaign not found", 404);
  if (campaign.status === "archived") throw new RecordingAssignmentError("Campaign is archived", 409);
  return campaign;
}

async function auditAssignment(
  client: pg.PoolClient,
  requestId: string | undefined,
  campaignId: string,
  before: string | null,
  after: string | null
) {
  if (!requestId) return;
  await client.query(
    `update admin_audit_events set metadata_json = metadata_json || $2::jsonb
    where request_id = $1`,
    [requestId, JSON.stringify({ campaignId, voicemailRecordingId: { from: before, to: after } })]
  );
}

export async function createRecording(
  pool: pg.Pool,
  input: {
    name: string;
    filePath: string;
    runtimeFilePath: string;
    durationSeconds: number;
    fileSizeBytes: number;
    campaignId: string;
    useForCampaign: boolean;
    requestId?: string;
  }
): Promise<AdminOverviewResponse["recordings"][number]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCampaignVoicemail(client, input.campaignId);
    const campaign = await getAssignableCampaign(client, input.campaignId);
    const result = await client.query<RecordingRow>(
      `insert into recordings (name, file_path, runtime_file_path, campaign_id, is_active, duration_seconds, file_size_bytes)
       values ($1, $2, $3, $4, true, $5, $6)
       returning id, name, runtime_file_path, campaign_id, duration_seconds, file_size_bytes, is_active`,
      [
        input.name,
        input.filePath,
        input.runtimeFilePath,
        input.campaignId,
        input.durationSeconds,
        input.fileSizeBytes
      ]
    );
    const row = result.rows[0];
    if (input.useForCampaign) {
      await client.query(
        "update campaigns set voicemail_recording_id = $2, updated_at = now() where id = $1",
        [input.campaignId, row.id]
      );
      await auditAssignment(
        client,
        input.requestId,
        input.campaignId,
        campaign.voicemail_recording_id,
        row.id
      );
    }
    await client.query("commit");
    return mapRecordingRow({ ...row, campaign_name: campaign.name, is_assigned: input.useForCampaign });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function setCampaignVoicemail(
  pool: pg.Pool,
  campaignId: string,
  recordingId: string | null,
  requestId?: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCampaignVoicemail(client, campaignId);
    const campaign = await getAssignableCampaign(client, campaignId);
    if (recordingId !== null) {
      const recording = await client.query(
        "select id from recordings where id = $1 and campaign_id = $2 and is_active = true for key share",
        [recordingId, campaignId]
      );
      if (!recording.rowCount)
        throw new RecordingAssignmentError("Recording is not available for this campaign", 409);
    }
    await client.query("update campaigns set voicemail_recording_id = $2, updated_at = now() where id = $1", [
      campaignId,
      recordingId
    ]);
    await auditAssignment(client, requestId, campaignId, campaign.voicemail_recording_id, recordingId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export type DeleteRecordingResult =
  | { status: "deleted"; filePath: string }
  | { status: "in_use" }
  | { status: "assigned" }
  | { status: "not_found" };

export async function deleteRecording(pool: pg.Pool, recordingId: string): Promise<DeleteRecordingResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Configuration/publisher lock precedes admission and campaign audio locks.
    // Never take it from a call-admission participant (reverse ordering).
    await client.query("select pg_advisory_xact_lock(72204,0)");
    const owner = await client.query<{ campaign_id: string }>(
      "select campaign_id from recordings where id = $1 and campaign_id is not null and is_active = true",
      [recordingId]
    );
    if (!owner.rows[0]) {
      await client.query("rollback");
      return { status: "not_found" };
    }
    await lockCampaignVoicemail(client, owner.rows[0].campaign_id);
    const existing = await client.query<{ file_path: string }>(
      "select file_path from recordings where id = $1 and is_active = true for update",
      [recordingId]
    );
    if (!existing.rows[0]) {
      await client.query("rollback");
      return { status: "not_found" };
    }
    const assigned = await client.query(
      "select 1 from campaigns where id = $1 and voicemail_recording_id = $2",
      [owner.rows[0].campaign_id, recordingId]
    );
    if (assigned.rowCount) {
      await client.query("rollback");
      return { status: "assigned" };
    }
    const activeReference = await client.query(
      `select 1 from calls c where recording_id = $1 and
       ((ended_at is null and state not in ('completed', 'failed', 'canceled')) or exists(
         select 1 from call_operations o where o.call_id=c.id and o.resolved_at is null)) limit 1`,
      [recordingId]
    );
    const inboundReference = await client.query(
      `select 1 from inbound_flow_versions where first_audio_id = $1 or second_audio_id = $1
       union all select 1 from inbound_queues where waiting_audio_id = $1
       union all select 1 from inbound_ingress_route_snapshots where waiting_audio_id = $1
       union all select 1 from inbound_ingress_evidence e left join calls c on c.id=e.call_id
         where e.route_snapshot #>> '{configuration,waiting_audio_id}'=$1::text
           and (e.terminal_at is null or c.ended_at is null or exists(
             select 1 from call_operations o where o.call_id=c.id and o.resolved_at is null))
       union all select 1 from inbound_queue_admissions a join calls c on c.id=a.call_id
         where a.waiting_audio_id=$1 and (c.ended_at is null or exists(
           select 1 from call_operations o where o.call_id=c.id and o.resolved_at is null)) limit 1`,
      [recordingId]
    );
    if (activeReference.rowCount || inboundReference.rowCount) {
      await client.query("rollback");
      return { status: "in_use" };
    }
    await client.query(
      "update recordings set is_active = false, is_default = false, updated_at = now() where id = $1",
      [recordingId]
    );
    await client.query("commit");
    return { status: "deleted", filePath: existing.rows[0].file_path };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreDeletedRecording(pool: pg.Pool, recordingId: string): Promise<void> {
  // Restoring after an unlink failure must never restore a campaign assignment.
  await pool.query(
    `update recordings set is_active = true, updated_at = now()
    where id = $1 and campaign_id is not null and is_active = false`,
    [recordingId]
  );
}

export async function getRecordingAudioFile(
  pool: pg.Pool,
  recordingId: string
): Promise<{ filePath: string; filename: string } | null> {
  const result = await pool.query<{ file_path: string; name: string }>(
    "select file_path, name from recordings where id = $1 and is_active = true and campaign_id is not null",
    [recordingId]
  );
  const row = result.rows[0];
  return row
    ? { filePath: row.file_path, filename: sanitizeDownloadFilename(row.name, extname(row.file_path)) }
    : null;
}

type RecordingRow = {
  id: string;
  name: string;
  runtime_file_path: string;
  duration_seconds: number;
  file_size_bytes: number;
  is_active: boolean;
  campaign_id: string;
  campaign_name: string;
  is_assigned: boolean | null;
};

function mapRecordingRow(row: RecordingRow): AdminOverviewResponse["recordings"][number] {
  return {
    id: row.id,
    name: row.name,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    isAssigned: row.is_assigned === true,
    durationSeconds: row.duration_seconds,
    fileSizeBytes: row.file_size_bytes,
    status: row.is_assigned ? "assigned" : row.is_active ? "ready" : "inactive"
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
