import type pg from "pg";
import type { ImportCsvResponse } from "@outbound-dialer/shared";
import { normalizePhoneNumber } from "./phone.js";

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
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
  const companyIndex = findColumn(parsed.headers, ["company", "business", "organization", "org"]);

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
          name: nameIndex >= 0 ? parsed.headers[nameIndex] : null,
          company: companyIndex >= 0 ? parsed.headers[companyIndex] : null
        }),
        parsed.rows.length
      ]
    );

    const importId = importInsert.rows[0].id;
    let importedRows = 0;
    let failedRows = 0;
    let duplicateRows = 0;

    for (const [rowIndex, row] of parsed.rows.entries()) {
      const rowNumber = rowIndex + 2;
      const phoneNumber = (row[phoneIndex] ?? "").trim();
      const normalized = normalizePhoneNumber(phoneNumber, defaultCountryCode);
      const mappedFields = Object.fromEntries(
        parsed.headers.map((header, index) => [header, (row[index] ?? "").trim()])
      );

      if (!normalized.ok) {
        await insertCsvImportFailure(client, importId, rowNumber, normalized.reason, mappedFields);
        failedRows += 1;
        continue;
      }

      const displayName =
        nameIndex >= 0 && row[nameIndex]?.trim()
          ? row[nameIndex].trim()
          : companyIndex >= 0 && row[companyIndex]?.trim()
            ? row[companyIndex].trim()
            : phoneNumber;

      const insertResult = await client.query(
        `
          insert into contacts (
            campaign_id,
            phone_number,
            normalized_phone_number,
            display_name,
            source_row_json,
            mapped_fields_json,
            status
          )
          values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'new')
          on conflict (campaign_id, normalized_phone_number) do nothing
          returning id
        `,
        [
          campaignId,
          phoneNumber,
          normalized.number,
          displayName,
          JSON.stringify(mappedFields),
          JSON.stringify(mappedFields)
        ]
      );

      if (insertResult.rowCount) {
        importedRows += 1;
      } else {
        await insertCsvImportFailure(client, importId, rowNumber, "Duplicate phone number in this campaign", mappedFields);
        duplicateRows += 1;
        failedRows += 1;
      }
    }

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

async function insertCsvImportFailure(
  client: pg.PoolClient,
  importId: string,
  rowNumber: number,
  reason: string,
  row: Record<string, string>
): Promise<void> {
  await client.query(
    `
      insert into csv_import_failures (import_id, row_number, reason, row_json)
      values ($1, $2, $3, $4::jsonb)
    `,
    [importId, rowNumber, reason, JSON.stringify(row)]
  );
}

export function parseCsv(input: string): ParsedCsv {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field.trim());
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      field = "";
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field.trim());
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  const headers = (rows.shift() ?? []).map((header) => header.trim()).filter(Boolean);
  if (!headers.length) {
    throw new CsvImportError("CSV header row is required");
  }

  return {
    headers,
    rows: rows.filter((csvRow) => csvRow.some((value) => value.trim().length > 0))
  };
}

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => candidates.includes(header));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function isCsvFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".csv");
}
