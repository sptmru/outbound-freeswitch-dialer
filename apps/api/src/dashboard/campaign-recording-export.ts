import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { ZipArchive, type ArchiverError } from "archiver";
import type pg from "pg";

const ZIP_ENTRY_DATE = new Date("1980-01-01T00:00:00.000Z");
const FILE_CHECK_CONCURRENCY = 16;

type RecordingRow = {
  id: string;
  call_recording_path: string;
  created_at: Date;
  destination_number: string;
  lead_name: string | null;
  outcome: string | null;
};

type ExportableRecording = {
  id: string;
  filePath: string;
  createdAt: Date;
  destinationNumber: string;
  leadName: string | null;
  outcome: string | null;
};

type SkippedRecording = Omit<ExportableRecording, "filePath"> & {
  reason: "empty" | "missing" | "not_regular" | "unsafe_path";
};

export type CampaignRecordingExport =
  | { status: "campaign_not_found" }
  | { status: "no_recordings" }
  | {
      status: "ready";
      filename: string;
      includedCount: number;
      skippedCount: number;
      stream: Readable;
      abort: () => void;
    };

export async function openCampaignRecordingExport(
  pool: pg.Pool,
  campaignId: string,
  storageDir: string
): Promise<CampaignRecordingExport> {
  const campaign = await pool.query<{ id: string }>("select id from campaigns where id = $1 limit 1", [
    campaignId
  ]);
  if (!campaign.rowCount) {
    return { status: "campaign_not_found" };
  }

  const recordings = await pool.query<RecordingRow>(
    `
      select
        calls.id,
        calls.call_recording_path,
        calls.created_at,
        calls.destination_number,
        resolved_contact.display_name as lead_name,
        calls.outcome
      from calls
      left join lateral (
        select matched_contacts.display_name
        from contacts matched_contacts
        where matched_contacts.normalized_phone_number = calls.normalized_destination_number
          and nullif(btrim(matched_contacts.display_name), '') is not null
        order by
          coalesce(matched_contacts.id = calls.contact_id, false) desc,
          coalesce(matched_contacts.campaign_id = calls.campaign_id, false) desc,
          matched_contacts.created_at desc,
          matched_contacts.id desc
        limit 1
      ) resolved_contact on true
      where calls.campaign_id = $1
        and calls.call_recording_status = 'available'
        and calls.call_recording_path is not null
      order by calls.created_at asc, calls.id asc
    `,
    [campaignId]
  );
  const checked = await filterExportableRecordings(recordings.rows, storageDir);
  if (!checked.included.length) {
    return { status: "no_recordings" };
  }

  const { stream, abort } = createRecordingArchive(checked.included, checked.skipped);
  return {
    status: "ready",
    filename: `campaign-${campaignId}-recordings.zip`,
    includedCount: checked.included.length,
    skippedCount: checked.skipped.length,
    stream,
    abort
  };
}

async function filterExportableRecordings(
  rows: RecordingRow[],
  storageDir: string
): Promise<{ included: ExportableRecording[]; skipped: SkippedRecording[] }> {
  const accepted: Array<ExportableRecording | null> = new Array(rows.length).fill(null);
  const skipped: Array<SkippedRecording | null> = new Array(rows.length).fill(null);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(FILE_CHECK_CONCURRENCY, rows.length) }, async () => {
      while (nextIndex < rows.length) {
        const index = nextIndex++;
        const row = rows[index];
        if (!row) continue;

        const metadata = {
          id: row.id,
          createdAt: row.created_at,
          destinationNumber: row.destination_number,
          leadName: row.lead_name,
          outcome: row.outcome
        };

        const expectedPath = resolve(storageDir, `${row.id}.wav`);
        if (resolve(row.call_recording_path) !== expectedPath) {
          skipped[index] = { ...metadata, reason: "unsafe_path" };
          continue;
        }

        let fileStat;
        try {
          fileStat = await lstat(expectedPath);
        } catch (error) {
          if (isMissingFileError(error)) {
            skipped[index] = { ...metadata, reason: "missing" };
            continue;
          }
          throw new Error("Could not verify campaign recording storage");
        }
        if (!fileStat.isFile()) {
          skipped[index] = { ...metadata, reason: "not_regular" };
          continue;
        }
        if (fileStat.size === 0) {
          skipped[index] = { ...metadata, reason: "empty" };
          continue;
        }
        accepted[index] = {
          ...metadata,
          filePath: expectedPath
        };
      }
    })
  );

  return {
    included: accepted.filter((recording): recording is ExportableRecording => recording !== null),
    skipped: skipped.filter((recording): recording is SkippedRecording => recording !== null)
  };
}

function createRecordingArchive(
  recordings: ExportableRecording[],
  skipped: SkippedRecording[] = []
): {
  stream: Readable;
  abort: () => void;
} {
  const output = new PassThrough();
  // WAV recordings are already media artifacts; storing them avoids spending
  // CPU on large concurrent downloads while retaining ZIP packaging.
  const archive = new ZipArchive({ store: true });
  let aborted = false;

  const fail = () => {
    if (aborted || output.destroyed) return;
    aborted = true;
    archive.abort();
    output.destroy(new Error("Campaign recording archive failed"));
  };
  // Retention can unlink a recording after the preflight. Abort rather than
  // deliver an archive whose manifest claims a now-missing file was included.
  archive.on("warning", (_error: ArchiverError) => fail());
  archive.on("error", fail);
  archive.pipe(output);

  archive.append(recordingManifest(recordings, skipped), {
    name: "manifest.csv",
    date: ZIP_ENTRY_DATE,
    mode: 0o600
  });

  for (const recording of recordings) {
    archive.file(recording.filePath, {
      name: `${recording.id}.wav`,
      date: ZIP_ENTRY_DATE,
      mode: 0o600
    });
  }
  void archive.finalize().catch(fail);

  return {
    stream: output,
    abort: () => {
      if (aborted) return;
      aborted = true;
      archive.abort();
      output.destroy();
    }
  };
}

function recordingManifest(recordings: ExportableRecording[], skipped: SkippedRecording[] = []): string {
  const rows = [
    [
      "call_id",
      "created_at",
      "lead_name",
      "destination_number",
      "outcome",
      "filename",
      "export_status",
      "skip_reason"
    ],
    ...recordings.map((recording) => [
      recording.id,
      recording.createdAt.toISOString(),
      recording.leadName ?? "",
      recording.destinationNumber,
      recording.outcome ?? "",
      `${recording.id}.wav`,
      "included",
      ""
    ]),
    ...skipped.map((recording) => [
      recording.id,
      recording.createdAt.toISOString(),
      recording.leadName ?? "",
      recording.destinationNumber,
      recording.outcome ?? "",
      "",
      "skipped",
      recording.reason
    ])
  ];
  return `${rows.map((row) => row.map(spreadsheetSafeCsvCell).join(",")).join("\n")}\n`;
}

function spreadsheetSafeCsvCell(value: string): string {
  const safeValue = /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export const __testing = {
  createRecordingArchive,
  filterExportableRecordings,
  recordingManifest,
  spreadsheetSafeCsvCell
};
