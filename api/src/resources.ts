import type { Db } from './db.js';

export type Resource = {
  path: string;        // URL segment
  table: string;       // database table
  perm: string;        // object name in role_permission and field_permission
  writable: boolean;
  // columns only the database may set (triggers, counters, timestamps)
  readOnlyCols: string[];
  defaultOwner?: boolean; // owner_user_id falls back to the caller when not sent
};

const SYSTEM = ['id', 'tenant_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'version'];

export const resources: Resource[] = [
  { path: 'accounts',      table: 'account',        perm: 'account',      writable: true,  readOnlyCols: [], defaultOwner: true },
  { path: 'contacts',      table: 'contact',        perm: 'contact',      writable: true,  readOnlyCols: [], defaultOwner: true },
  { path: 'opportunities', table: 'opportunity',    perm: 'opportunity',  writable: true,  readOnlyCols: ['is_closed', 'is_won'], defaultOwner: true },
  { path: 'cases',         table: 'support_case',   perm: 'case',         writable: true,
    readOnlyCols: ['case_number', 'opened_at', 'first_response_at', 'resolved_at', 'closed_at', 'first_response_due_at', 'resolution_due_at'] },
  { path: 'case-comments', table: 'case_comment',   perm: 'case_comment', writable: true,  readOnlyCols: [] },
  { path: 'activities',    table: 'activity',       perm: 'activity',     writable: true,  readOnlyCols: [], defaultOwner: true },
  { path: 'pipeline-stages', table: 'pipeline_stage', perm: 'pipeline_stage', writable: false, readOnlyCols: [] },
  { path: 'queues',        table: 'queue',          perm: 'queue',        writable: false, readOnlyCols: [] },
];

const columnCache = new Map<string, string[]>();

// Column lists come from the database itself, so the API cannot drift from the schema.
export async function columnsOf(db: Db, table: string): Promise<string[]> {
  const hit = columnCache.get(table);
  if (hit) return hit;
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  const cols = r.rows.map((x) => x.column_name as string);
  columnCache.set(table, cols);
  return cols;
}

export const isSystemCol = (c: string) => SYSTEM.includes(c);
export const alwaysVisible = ['id', 'created_at', 'updated_at', 'version'];
