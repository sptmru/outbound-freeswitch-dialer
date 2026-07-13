import type pg from "pg";
import type {
  AdminOverviewResponse,
  AdminUserListResponse,
  CsvImportHistoryResponse
} from "@outbound-dialer/shared";

export type AdminLibraryFilters = {
  page: number;
  pageSize: number;
  q?: string;
};

type AdminUserRow = AdminOverviewResponse["users"][number] & { total_count: string };

export async function getUsers(pool: pg.Pool): Promise<AdminOverviewResponse["users"]> {
  return (await queryUsers(pool, { limit: null, offset: 0 })).items;
}

export async function getUsersPage(
  pool: pg.Pool,
  filters: AdminLibraryFilters
): Promise<AdminUserListResponse> {
  const result = await queryUsers(pool, {
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

async function queryUsers(
  pool: pg.Pool,
  filters: { q?: string; limit: number | null; offset: number }
): Promise<{ items: AdminOverviewResponse["users"]; total: number }> {
  const q = filters.q?.trim() || null;
  const result = await pool.query<AdminUserRow>(
    `
      select
        users.id,
        users.email,
        users.name,
        users.role,
        users.is_active as "isActive",
        case when agents.id is null then null else agents.registered end as "agentRegistered",
        count(*) over() as total_count
      from users
      left join agents on agents.user_id = users.id
      where (
        $1::text is null
        or users.name ilike '%' || $1 || '%'
        or users.email ilike '%' || $1 || '%'
        or users.role::text ilike '%' || $1 || '%'
        or case when users.is_active then 'active' else 'inactive' end ilike '%' || $1 || '%'
      )
      order by users.created_at desc
      limit $2 offset $3
    `,
    [q, filters.limit, filters.offset]
  );
  return {
    items: result.rows.map(({ total_count: _totalCount, ...user }) => user),
    total: Number(result.rows[0]?.total_count ?? 0)
  };
}

type CsvImportRow = {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  filename: string;
  status: string;
  total_rows: number;
  imported_rows: number;
  failed_rows: number;
  field_mapping_json: { duplicateRows?: number } | null;
  created_at: Date;
  completed_at: Date | null;
  total_count: string;
};

export async function getCsvImportsPage(
  pool: pg.Pool,
  filters: AdminLibraryFilters
): Promise<CsvImportHistoryResponse> {
  const q = filters.q?.trim() || null;
  const offset = (filters.page - 1) * filters.pageSize;
  const result = await pool.query<CsvImportRow>(
    `
      select
        csv_imports.id,
        csv_imports.campaign_id,
        campaigns.name as campaign_name,
        csv_imports.filename,
        csv_imports.status,
        csv_imports.total_rows,
        csv_imports.imported_rows,
        csv_imports.failed_rows,
        csv_imports.field_mapping_json,
        csv_imports.created_at,
        csv_imports.completed_at,
        count(*) over() as total_count
      from csv_imports
      left join campaigns on campaigns.id = csv_imports.campaign_id
      where (
        $1::text is null
        or csv_imports.filename ilike '%' || $1 || '%'
        or csv_imports.status ilike '%' || $1 || '%'
        or campaigns.name ilike '%' || $1 || '%'
      )
      order by csv_imports.created_at desc
      limit $2 offset $3
    `,
    [q, filters.pageSize, offset]
  );
  const total = Number(result.rows[0]?.total_count ?? 0);
  return {
    imports: result.rows.map((row) => ({
      id: row.id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? "Deleted campaign",
      filename: row.filename,
      status: row.status,
      totalRows: Number(row.total_rows),
      importedRows: Number(row.imported_rows),
      failedRows: Number(row.failed_rows),
      duplicateRows: Number(row.field_mapping_json?.duplicateRows ?? 0),
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString()
    })),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: total ? Math.ceil(total / filters.pageSize) : 0
  };
}
