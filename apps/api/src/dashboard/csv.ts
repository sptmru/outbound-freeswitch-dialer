import type pg from "pg";
import type { ImportCsvResponse, SuppressionImportResponse } from "@outbound-dialer/shared";
import { normalizePhoneNumber } from "./phone.js";

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export interface CsvParseLimits {
  maxBytes?: number;
  maxCellCharacters?: number;
  maxCells?: number;
  maxColumns?: number;
  maxRows?: number;
}

const CSV_DATABASE_CHUNK_SIZE = 1_000;
const DEFAULT_CSV_MAX_BYTES = 67_108_864;
const DEFAULT_CSV_MAX_ROWS = 250_000;
const DEFAULT_CSV_MAX_COLUMNS = 128;
const DEFAULT_CSV_MAX_CELLS = 2_000_000;
const DEFAULT_CSV_MAX_CELL_CHARACTERS = 65_536;

export async function importSuppressionFromCsv(
  pool: pg.Pool,
  input: {
    actorUserId: string;
    filename: string;
    parsed: ParsedCsv;
    defaultCountryCode?: string;
  }
): Promise<SuppressionImportResponse> {
  const phoneIndex = findColumn(input.parsed.headers, ["phone", "phone_number", "number", "mobile", "cell"]);
  if (phoneIndex === -1) {
    throw new CsvImportError("Suppression CSV must include a phone column");
  }
  const reasonIndex = findColumn(input.parsed.headers, ["reason", "note", "notes"]);
  const failures: SuppressionImportResponse["failures"] = [];
  const validRows: Array<{
    rowNumber: number;
    phoneNumber: string;
    normalizedPhoneNumber: string;
    reason: string;
  }> = [];

  for (const [rowIndex, row] of input.parsed.rows.entries()) {
    const rowNumber = rowIndex + 2;
    const phoneNumber = (row[phoneIndex] ?? "").trim();
    const reason = (reasonIndex >= 0 ? row[reasonIndex] : "")?.trim() || "Suppression CSV import";
    const normalized = normalizePhoneNumber(phoneNumber, input.defaultCountryCode);
    if (!normalized.ok) {
      failures.push({ rowNumber, reason: normalized.reason });
      continue;
    }
    validRows.push({ rowNumber, phoneNumber, normalizedPhoneNumber: normalized.number, reason });
  }

  if (!validRows.length) {
    return {
      filename: input.filename,
      totalRows: input.parsed.rows.length,
      importedRows: 0,
      updatedRows: 0,
      failedRows: failures.length,
      failures: failures.slice(0, 50)
    };
  }

  // Preserve the loop import's final-value semantics while doing a bounded
  // number of database round trips: the last row for a number wins, earlier
  // duplicates still count as updates and retain individual audit events.
  const latestByNumber = new Map<string, (typeof validRows)[number]>();
  for (const row of validRows) latestByNumber.set(row.normalizedPhoneNumber, row);
  const uniqueRows = [...latestByNumber.values()].sort((left, right) =>
    compareNormalizedPhoneNumbers(left.normalizedPhoneNumber, right.normalizedPhoneNumber)
  );
  const client = await pool.connect();
  let importedRows = 0;

  try {
    await client.query("begin");
    await lockNormalizedPhoneNumbers(
      client,
      uniqueRows.map((row) => row.normalizedPhoneNumber)
    );
    const entryIds = new Map<string, string>();
    for (const chunk of chunks(uniqueRows, CSV_DATABASE_CHUNK_SIZE)) {
      const upserted = await client.query<{
        id: string;
        inserted: boolean;
        normalized_phone_number: string;
      }>(
        `
        with input_rows as (
          select *
          from jsonb_to_recordset($1::jsonb) as item(
            phone_number text,
            normalized_phone_number text,
            reason text
          )
        )
        insert into suppression_entries (phone_number, normalized_phone_number, reason, created_by_user_id)
        select phone_number, normalized_phone_number, reason, $2
        from input_rows
        order by normalized_phone_number
        on conflict (normalized_phone_number)
        do update set phone_number = excluded.phone_number,
                      reason = excluded.reason,
                      created_by_user_id = excluded.created_by_user_id
        returning id, normalized_phone_number, (xmax = 0) as inserted
      `,
        [
          JSON.stringify(
            chunk.map((row) => ({
              phone_number: row.phoneNumber,
              normalized_phone_number: row.normalizedPhoneNumber,
              reason: row.reason
            }))
          ),
          input.actorUserId
        ]
      );
      importedRows += upserted.rows.filter((row) => row.inserted).length;
      for (const row of upserted.rows) entryIds.set(row.normalized_phone_number, row.id);
    }
    for (const chunk of chunks(validRows, CSV_DATABASE_CHUNK_SIZE)) {
      await client.query(
        `
        with input_rows as (
          select *
          from jsonb_to_recordset($1::jsonb) as item(
            suppression_entry_id uuid,
            phone_number text,
            normalized_phone_number text,
            reason text,
            row_number integer
          )
        )
        insert into suppression_events (
          suppression_entry_id, actor_user_id, event_type, phone_number,
          normalized_phone_number, reason, metadata_json
        )
        select suppression_entry_id, $2, 'imported', phone_number,
               normalized_phone_number, reason,
               jsonb_build_object('filename', $3::text, 'rowNumber', row_number)
        from input_rows
      `,
        [
          JSON.stringify(
            chunk.map((row) => ({
              suppression_entry_id: entryIds.get(row.normalizedPhoneNumber),
              phone_number: row.phoneNumber,
              normalized_phone_number: row.normalizedPhoneNumber,
              reason: row.reason,
              row_number: row.rowNumber
            }))
          ),
          input.actorUserId,
          input.filename
        ]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return {
    filename: input.filename,
    totalRows: input.parsed.rows.length,
    importedRows,
    updatedRows: validRows.length - importedRows,
    failedRows: failures.length,
    failures: failures.slice(0, 50)
  };
}

export class CsvImportError extends Error {}

export async function importContactsFromCsv(
  pool: pg.Pool,
  campaignId: string,
  filename: string,
  parsed: ParsedCsv,
  defaultCountryCode?: string
): Promise<ImportCsvResponse> {
  const phoneIndex = findColumn(parsed.headers, ["phone", "phone_number", "number", "mobile", "cell"]);
  if (phoneIndex === -1) {
    throw new CsvImportError("CSV must include a phone column");
  }

  const nameIndex = findColumn(parsed.headers, ["name", "full_name", "contact", "display_name"]);
  if (nameIndex === -1) {
    throw new CsvImportError("CSV must include a name column");
  }
  const companyIndex = findColumn(parsed.headers, ["company", "business", "organization", "org"]);

  const validRows: Array<{
    rowNumber: number;
    phoneNumber: string;
    normalizedPhoneNumber: string;
    displayName: string;
    mappedFields: Record<string, string>;
  }> = [];
  const initialFailures: Array<{ rowNumber: number; reason: string; row: Record<string, string> }> = [];
  for (const [rowIndex, row] of parsed.rows.entries()) {
    const rowNumber = rowIndex + 2;
    const phoneNumber = (row[phoneIndex] ?? "").trim();
    const displayName = (row[nameIndex] ?? "").trim();
    const mappedFields = Object.fromEntries(
      parsed.headers.map((header, index) => [header, (row[index] ?? "").trim()])
    );
    if (!displayName) {
      initialFailures.push({ rowNumber, reason: "Name is required", row: mappedFields });
      continue;
    }
    const normalized = normalizePhoneNumber(phoneNumber, defaultCountryCode);
    if (!normalized.ok) {
      initialFailures.push({ rowNumber, reason: normalized.reason, row: mappedFields });
      continue;
    }
    validRows.push({
      rowNumber,
      phoneNumber,
      normalizedPhoneNumber: normalized.number,
      displayName,
      mappedFields
    });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const importInsert = await client.query<{ id: string }>(
      `
        insert into csv_imports (campaign_id, filename, status, field_mapping_json, total_rows)
        values ($1, $2, 'processing', $3::jsonb, $4)
        returning id
      `,
      [
        campaignId,
        filename,
        JSON.stringify({
          phone: parsed.headers[phoneIndex],
          name: parsed.headers[nameIndex],
          company: companyIndex >= 0 ? parsed.headers[companyIndex] : null
        }),
        parsed.rows.length
      ]
    );

    const importId = importInsert.rows[0].id;
    await insertCsvImportFailures(client, importId, initialFailures);

    const firstRowByNumber = new Map<string, (typeof validRows)[number]>();
    for (const row of validRows) {
      if (!firstRowByNumber.has(row.normalizedPhoneNumber)) {
        firstRowByNumber.set(row.normalizedPhoneNumber, row);
      }
    }
    const uniqueValidRows = [...firstRowByNumber.values()].sort((left, right) =>
      compareNormalizedPhoneNumbers(left.normalizedPhoneNumber, right.normalizedPhoneNumber)
    );
    await lockNormalizedPhoneNumbers(
      client,
      uniqueValidRows.map((row) => row.normalizedPhoneNumber)
    );
    const insertedNumbers = new Set<string>();
    for (const chunk of chunks(uniqueValidRows, CSV_DATABASE_CHUNK_SIZE)) {
      const inserted = await client.query<{ normalized_phone_number: string }>(
        `
          with input_rows as (
            select *
            from jsonb_to_recordset($2::jsonb) as item(
              row_number integer,
              phone_number text,
              normalized_phone_number text,
              display_name text,
              mapped_fields jsonb
            )
          )
          insert into contacts (
            campaign_id, phone_number, normalized_phone_number, display_name,
            source_row_json, mapped_fields_json, status
          )
          select $1, phone_number, normalized_phone_number, display_name,
                 mapped_fields, mapped_fields, 'new'
          from input_rows
          order by normalized_phone_number
          on conflict (campaign_id, normalized_phone_number) do nothing
          returning normalized_phone_number
        `,
        [
          campaignId,
          JSON.stringify(
            chunk.map((row) => ({
              row_number: row.rowNumber,
              phone_number: row.phoneNumber,
              normalized_phone_number: row.normalizedPhoneNumber,
              display_name: row.displayName,
              mapped_fields: row.mappedFields
            }))
          )
        ]
      );
      for (const row of inserted.rows) insertedNumbers.add(row.normalized_phone_number);
    }

    const duplicateFailures: typeof initialFailures = [];
    for (const row of validRows) {
      const firstRow = firstRowByNumber.get(row.normalizedPhoneNumber);
      if (firstRow?.rowNumber !== row.rowNumber || !insertedNumbers.has(row.normalizedPhoneNumber)) {
        duplicateFailures.push({
          rowNumber: row.rowNumber,
          reason: "Duplicate phone number in this campaign",
          row: row.mappedFields
        });
      }
    }
    await insertCsvImportFailures(client, importId, duplicateFailures);

    const importedRows = insertedNumbers.size;
    const duplicateRows = duplicateFailures.length;
    const failedRows = initialFailures.length + duplicateRows;

    await client.query(
      `
        update csv_imports
        set status = 'completed',
            imported_rows = $2,
            failed_rows = $3,
            field_mapping_json = field_mapping_json || $4::jsonb,
            completed_at = now()
        where id = $1
      `,
      [importId, importedRows, failedRows, JSON.stringify({ duplicateRows })]
    );
    await client.query("commit");

    return {
      importId,
      filename,
      totalRows: parsed.rows.length,
      importedRows,
      failedRows,
      duplicateRows,
      detectedColumns: parsed.headers
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function insertCsvImportFailures(
  client: pg.PoolClient,
  importId: string,
  failures: Array<{ rowNumber: number; reason: string; row: Record<string, string> }>
): Promise<void> {
  if (!failures.length) return;
  for (const chunk of chunks(failures, CSV_DATABASE_CHUNK_SIZE)) {
    await client.query(
      `
      insert into csv_import_failures (import_id, row_number, reason, row_json)
      select $1, item.row_number, item.reason, item.row_json
      from jsonb_to_recordset($2::jsonb) as item(
        row_number integer,
        reason text,
        row_json jsonb
      )
    `,
      [
        importId,
        JSON.stringify(
          chunk.map((failure) => ({
            row_number: failure.rowNumber,
            reason: failure.reason,
            row_json: failure.row
          }))
        )
      ]
    );
  }
}

export function parseCsv(input: string, limits: CsvParseLimits = {}): ParsedCsv {
  const maxBytes = limits.maxBytes ?? DEFAULT_CSV_MAX_BYTES;
  const maxRows = limits.maxRows ?? DEFAULT_CSV_MAX_ROWS;
  const maxColumns = limits.maxColumns ?? DEFAULT_CSV_MAX_COLUMNS;
  const maxCells = limits.maxCells ?? DEFAULT_CSV_MAX_CELLS;
  const maxCellCharacters = limits.maxCellCharacters ?? DEFAULT_CSV_MAX_CELL_CHARACTERS;
  if (Buffer.byteLength(input, "utf8") > maxBytes) {
    throw new CsvImportError(`CSV exceeds configured limit of ${maxBytes} bytes`);
  }
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let cellCount = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      if (field.length > maxCellCharacters) {
        throw new CsvImportError(`CSV cell exceeds structural limit of ${maxCellCharacters} characters`);
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field.trim());
      enforceCsvColumnLimit(row.length, maxColumns);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field.trim());
      enforceCsvColumnLimit(row.length, maxColumns);
      if (row.some((value) => value.length > 0)) {
        cellCount += row.length;
        enforceCsvCellCountLimit(cellCount, maxCells);
        rows.push(row);
        enforceCsvRowLimit(rows.length, maxRows);
      }
      field = "";
      row = [];
      continue;
    }

    field += char;
    if (field.length > maxCellCharacters) {
      throw new CsvImportError(`CSV cell exceeds structural limit of ${maxCellCharacters} characters`);
    }
  }

  if (inQuotes) {
    throw new CsvImportError("CSV contains an unterminated quoted field");
  }
  row.push(field.trim());
  enforceCsvColumnLimit(row.length, maxColumns);
  if (row.some((value) => value.length > 0)) {
    cellCount += row.length;
    enforceCsvCellCountLimit(cellCount, maxCells);
    rows.push(row);
    enforceCsvRowLimit(rows.length, maxRows);
  }

  const headers = (rows.shift() ?? []).map((header, index) => {
    const trimmed = header.trim();
    return index === 0 ? trimmed.replace(/^\uFEFF/, "") : trimmed;
  });
  if (!headers.length) {
    throw new CsvImportError("CSV header row is required");
  }
  if (headers.some((header) => !header)) {
    throw new CsvImportError("CSV header names cannot be blank");
  }
  if (new Set(headers.map((header) => header.toLowerCase())).size !== headers.length) {
    throw new CsvImportError("CSV header names must be unique");
  }
  const widerRowIndex = rows.findIndex((csvRow) => csvRow.length > headers.length);
  if (widerRowIndex >= 0) {
    throw new CsvImportError(`CSV row ${widerRowIndex + 2} has more values than the header row`);
  }

  return {
    headers,
    rows: rows.filter((csvRow) => csvRow.some((value) => value.trim().length > 0))
  };
}

function enforceCsvColumnLimit(columns: number, maxColumns: number): void {
  if (columns > maxColumns) {
    throw new CsvImportError(`CSV exceeds structural limit of ${maxColumns} columns`);
  }
}

function enforceCsvCellCountLimit(cells: number, maxCells: number): void {
  if (cells > maxCells) {
    throw new CsvImportError(`CSV exceeds structural limit of ${maxCells} cells`);
  }
}

function enforceCsvRowLimit(rowsIncludingHeader: number, maxRows: number | undefined): void {
  if (maxRows !== undefined && Math.max(0, rowsIncludingHeader - 1) > maxRows) {
    throw new CsvImportError(`CSV exceeds configured limit of ${maxRows} data rows`);
  }
}

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => candidates.includes(header));
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isCsvFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".csv");
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function lockNormalizedPhoneNumbers(
  client: pg.PoolClient,
  normalizedPhoneNumbers: string[]
): Promise<void> {
  const ordered = [...new Set(normalizedPhoneNumbers)].sort(compareNormalizedPhoneNumbers);
  for (const chunk of chunks(ordered, CSV_DATABASE_CHUNK_SIZE)) {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended(phone_number, 913202607))
       from unnest($1::text[]) as numbers(phone_number)
       order by phone_number collate "C"`,
      [chunk]
    );
  }
}

function compareNormalizedPhoneNumbers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
