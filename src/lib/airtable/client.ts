import Airtable from 'airtable';
import { airtableCircuitBreaker, CircuitBreakerError } from './circuit-breaker';
import { validateRecord } from './schemas';
import { AirtableCache, airtableCache } from './cache';
import { writeQueue } from './write-queue';
import {
  getSupabaseTable,
  isSupabaseEnabled,
  SupabaseTableWrapper,
  type SelectOptions,
} from '@/lib/supabase/client';

// Validate env vars at module load time
if (!process.env.AIRTABLE_PAT && !process.env.SUPABASE_URL) {
  console.error('[Airtable] AIRTABLE_PAT is missing. Airtable queries will fail unless SUPABASE_URL is configured.');
}
if (!process.env.AIRTABLE_BASE_ID && !process.env.SUPABASE_URL) {
  console.error('[Airtable] AIRTABLE_BASE_ID is missing. Airtable queries will fail unless SUPABASE_URL is configured.');
}

// Lazy-initialized to avoid throwing during Next.js build (env vars unavailable at build time)
let _base: ReturnType<InstanceType<typeof Airtable>['base']> | null = null;

type DataTable = Airtable.Table<Airtable.FieldSet> | SupabaseTableWrapper;

export function getAirtableBase() {
  if (!_base) {
    const airtable = new Airtable({
      apiKey: process.env.AIRTABLE_PAT,
    });
    _base = airtable.base(process.env.AIRTABLE_BASE_ID!);
  }
  return _base;
}

function getTable(tableName: string): DataTable {
  if (isSupabaseEnabled()) {
    return getSupabaseTable(tableName);
  }
  return getAirtableBase()(tableName);
}

function isSupabaseTable(table: DataTable): table is SupabaseTableWrapper {
  return table instanceof SupabaseTableWrapper;
}

export const Tables = {
  clients: () => getTable('Clients'),
  appointments: () => getTable('Appointments'),
  transactions: () => getTable('Transactions'),
  kpis: () => getTable('KPI Snapshots'),
  alerts: () => getTable('Alerts'),
  packages: () => getTable('Packages'),
  memberships: () => getTable('Memberships'),
  intakes: () => getTable('Client Intakes'),
  reviews: () => getTable('Reviews'),
  messagesLog: () => getTable('Messages Log'),
  competitorIntel: () => getTable('Competitor Intelligence'),
  intakeIntelligence: () => getTable('Intake Intelligence'),
  treatmentPlans: () => getTable('Treatment Plans'),
  chartNotes: () => getTable('Chart Notes'),
  rxProgramEnrollments: () => getTable('Rx Program Enrollments'),
} as const;

// Rate limiting: Airtable allows 5 req/sec per base
const MAX_QUEUE_SIZE = 100;
const MAX_RETRIES = 3;
const queue: (() => void)[] = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const next = queue.shift();
    next?.();
    await new Promise((r) => setTimeout(r, 210)); // ~4.7 req/sec
  }
  processing = false;
}

function getStatusCode(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    return (err as { statusCode: number }).statusCode;
  }
  return undefined;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = getStatusCode(err);

      if (status === 429 && attempt < MAX_RETRIES) {
        console.warn(`[Airtable] Rate limited (429). Retry ${attempt}/${MAX_RETRIES} after 1s...`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (status && status >= 500 && status < 600 && attempt < MAX_RETRIES) {
        console.warn(`[Airtable] Server error (${status}). Retry ${attempt}/${MAX_RETRIES} after 500ms...`);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      throw err;
    }
  }
  // Unreachable, but satisfies TypeScript
  throw new Error('[Airtable] Retry loop exited unexpectedly');
}

export function rateLimitedQuery<T>(fn: () => Promise<T>): Promise<T> {
  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new Error('Airtable queue overflow'));
  }

  return new Promise((resolve, reject) => {
    queue.push(() => {
      airtableCircuitBreaker
        .execute(() => withRetry(fn))
        .then((result) => {
          resolve(result);
          // On success, attempt to drain any queued failed writes
          writeQueue.drain(drainExecutor).catch(() => {});
        })
        .catch((err) => {
          reject(err);
        });
    });
    processQueue();
  });
}

/** Executor used by writeQueue.drain() to replay failed writes */
async function drainExecutor(entry: { table: string; recordId?: string; fields: Record<string, unknown>; operation: string }) {
  const table = getAirtableBase()(entry.table);
  if (entry.operation === 'create') {
    await table.create(entry.fields as Partial<Airtable.FieldSet>);
  } else if (entry.operation === 'update' && entry.recordId) {
    await table.update(entry.recordId, entry.fields as Partial<Airtable.FieldSet>);
  }
}

// Resolve a table accessor key to its Airtable table name
const TABLE_KEY_TO_NAME: Record<string, string> = {
  clients: 'Clients',
  appointments: 'Appointments',
  transactions: 'Transactions',
  kpis: 'KPI Snapshots',
  alerts: 'Alerts',
  packages: 'Packages',
  memberships: 'Memberships',
  intakes: 'Client Intakes',
  reviews: 'Reviews',
  messagesLog: 'Messages Log',
  competitorIntel: 'Competitor Intelligence',
  intakeIntelligence: 'Intake Intelligence',
  treatmentPlans: 'Treatment Plans',
  chartNotes: 'Chart Notes',
  rxProgramEnrollments: 'Rx Program Enrollments',
};

/**
 * Resolve table name from a Table object by matching against known table names.
 */
function resolveTableName(table: DataTable): string {
  if (isSupabaseTable(table)) {
    return table.name;
  }
  return (table as unknown as { name: string }).name || 'Unknown';
}

// Helper to fetch all records with pagination
// skipTestFilter: set true for tables without an "Is Test" field (e.g. Clients, Client Intakes)
export async function fetchAll<T = Record<string, unknown>>(
  table: Airtable.Table<Airtable.FieldSet> | SupabaseTableWrapper,
  options?: Airtable.SelectOptions<Airtable.FieldSet>,
  skipTestFilter?: boolean
): Promise<{ id: string; fields: T }[]> {
  const tableName = resolveTableName(table);
  const cacheKey = AirtableCache.buildKey(`fetchAll:${tableName}`, { options: options || {}, skipTestFilter });

  // Check cache first
  const cached = airtableCache.get<{ id: string; fields: T }[]>(cacheKey, tableName);
  if (cached) return cached;

  const formula = skipTestFilter
    ? (options?.filterByFormula || '')
    : options?.filterByFormula
      ? `AND(NOT({Is Test}), ${options.filterByFormula})`
      : 'NOT({Is Test})';
  const selectOptions = {
    ...options,
    ...(formula ? { filterByFormula: formula } : {}),
  } as SelectOptions;

  const records: { id: string; fields: T }[] = [];

  if (isSupabaseTable(table)) {
    const rows = await table.select(selectOptions).firstPage();
    const result = rows.map((r) => ({ id: r.id, fields: r.fields as T }));
    airtableCache.set(cacheKey, tableName, result);
    return result;
  }

  await rateLimitedQuery(() =>
    new Promise<void>((resolve, reject) => {
      table
        .select({
          ...options,
          ...(formula ? { filterByFormula: formula } : {}),
        })
        .eachPage(
          (pageRecords, fetchNextPage) => {
            pageRecords.forEach((r) => {
              records.push({ id: r.id, fields: r.fields as unknown as T });
            });
            fetchNextPage();
          },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
    })
  );

  // Cache the result
  airtableCache.set(cacheKey, tableName, records);
  return records;
}

// Helper to fetch first N records
// skipTestFilter: set true for tables without an "Is Test" field
export async function fetchFirst<T = Record<string, unknown>>(
  table: Airtable.Table<Airtable.FieldSet> | SupabaseTableWrapper,
  maxRecords: number,
  options?: Airtable.SelectOptions<Airtable.FieldSet>,
  skipTestFilter?: boolean
): Promise<{ id: string; fields: T }[]> {
  const tableName = resolveTableName(table);
  const cacheKey = AirtableCache.buildKey(`fetchFirst:${tableName}`, { maxRecords, options: options || {}, skipTestFilter });

  const cached = airtableCache.get<{ id: string; fields: T }[]>(cacheKey, tableName);
  if (cached) return cached;

  const formula = skipTestFilter
    ? (options?.filterByFormula || '')
    : options?.filterByFormula
      ? `AND(NOT({Is Test}), ${options.filterByFormula})`
      : 'NOT({Is Test})';

  const selectOptions = {
    maxRecords,
    ...options,
    ...(formula ? { filterByFormula: formula } : {}),
  } as SelectOptions;

  const result = isSupabaseTable(table)
    ? (await table.select(selectOptions).firstPage()).map((r) => ({ id: r.id, fields: r.fields as T }))
    : await rateLimitedQuery(async () => {
        const records = await table
          .select({
            maxRecords,
            ...options,
            ...(formula ? { filterByFormula: formula } : {}),
          })
          .firstPage();
        return records.map((r) => ({ id: r.id, fields: r.fields as unknown as T }));
      });

  airtableCache.set(cacheKey, tableName, result);
  return result;
}

// Helper to create a record (with validation and write-queue fallback)
export async function createRecord<T = Record<string, unknown>>(
  table: DataTable,
  fields: Partial<T>
): Promise<string> {
  const tableName = resolveTableName(table);

  // Validate before writing
  const validation = validateRecord(tableName, fields);
  if (!validation.success) {
    console.warn(
      `[Airtable:Create] Validation warning for "${tableName}":`,
      validation.errors
    );
    // Log but don't block - Airtable is the source of truth for required fields
  }

  try {
    const result = isSupabaseTable(table)
      ? await table.create(fields as Partial<Record<string, unknown>>)
      : await rateLimitedQuery(async () => {
          const record = await table.create(fields as Partial<Airtable.FieldSet>);
          return record.id;
        });

    const recordId = isSupabaseTable(table)
      ? (result as { id: string }).id
      : (result as string);

    // Invalidate cache for this table on successful write
    airtableCache.invalidateTable(tableName);
    return recordId;
  } catch (err) {
    // Queue the failed write for retry if it's a transient error
    if (err instanceof CircuitBreakerError || isTransientError(err)) {
      writeQueue.enqueue({
        table: tableName,
        fields: fields as Record<string, unknown>,
        operation: 'create',
      });
      console.warn(`[Airtable:Create] Queued failed create for "${tableName}" (will retry)`);
    }
    throw err;
  }
}

// Helper to update a record (with validation and write-queue fallback)
export async function updateRecord<T = Record<string, unknown>>(
  table: DataTable,
  recordId: string,
  fields: Partial<T>
): Promise<void> {
  const tableName = resolveTableName(table);

  // Validate before writing
  const validation = validateRecord(tableName, fields);
  if (!validation.success) {
    console.warn(
      `[Airtable:Update] Validation warning for "${tableName}" (${recordId}):`,
      validation.errors
    );
  }

  try {
    if (isSupabaseTable(table)) {
      await table.update(recordId, fields as Record<string, unknown>);
    } else {
      await rateLimitedQuery(async () => {
        await table.update(recordId, fields as Partial<Airtable.FieldSet>);
      });
    }

    // Invalidate cache for this table on successful write
    airtableCache.invalidateTable(tableName);
  } catch (err) {
    if (err instanceof CircuitBreakerError || isTransientError(err)) {
      writeQueue.enqueue({
        table: tableName,
        recordId,
        fields: fields as Record<string, unknown>,
        operation: 'update',
      });
      console.warn(`[Airtable:Update] Queued failed update for "${tableName}" (${recordId})`);
    }
    throw err;
  }
}

/** Check if an error is likely transient (server error or rate limit) */
function isTransientError(err: unknown): boolean {
  const status = getStatusCode(err);
  if (!status) return false;
  return status === 429 || (status >= 500 && status < 600);
}

// Re-export for external use
export { airtableCircuitBreaker } from './circuit-breaker';
export { airtableCache } from './cache';
export { writeQueue } from './write-queue';
export { TABLE_KEY_TO_NAME };
