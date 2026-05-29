import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface SelectOptions {
  maxRecords?: number;
  fields?: string[];
  filterByFormula?: string;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

const supabaseClient: SupabaseClient | null = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { fetch },
    })
  : null;

export function isSupabaseEnabled(): boolean {
  return Boolean(supabaseClient);
}

function requireSupabase(): SupabaseClient {
  if (!supabaseClient) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured to use Supabase');
  }
  return supabaseClient;
}

function quoteField(field: string): string {
  return `"${field.replace(/"/g, '""')}"`;
}

function buildSelectString(fields?: string[]): string {
  if (!fields || fields.length === 0) return '*';
  const quoted = fields.map((field) => quoteField(field));
  if (!quoted.some((field) => field.trim() === 'id')) {
    quoted.unshift('id');
  }
  return quoted.join(',');
}

function normalizeAirtableFieldValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function rowToAirtableRecord(row: Record<string, unknown>): AirtableRecord {
  const { id, ...rest } = row as { id: unknown } & Record<string, unknown>;
  return { id: String(id), fields: rest };
}

function splitTopLevelArgs(input: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inQuote) {
      current += char;
      if (char === quoteChar) {
        inQuote = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
      current += char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function unwrapQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeFormulaValue(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function resolveField(record: AirtableRecord, fieldExpression: string): unknown {
  const trimmed = fieldExpression.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const fieldName = trimmed.slice(1, -1);
    return record.fields[fieldName];
  }
  if (trimmed === 'RECORD_ID()') {
    return record.id;
  }
  return trimmed;
}

function compareValues(lhs: unknown, rhs: unknown, operator: string): boolean {
  const left = normalizeFormulaValue(lhs);
  const right = normalizeFormulaValue(rhs);

  if (operator === '=' || operator === '==') {
    return String(left) === String(right);
  }
  if (operator === '!=') {
    return String(left) !== String(right);
  }
  if (operator === '>') {
    return String(left) > String(right);
  }
  if (operator === '<') {
    return String(left) < String(right);
  }
  if (operator === '>=') {
    return String(left) >= String(right);
  }
  if (operator === '<=') {
    return String(left) <= String(right);
  }
  return false;
}

function evaluateFormula(record: AirtableRecord, formula: string): boolean {
  const trimmed = formula.trim();

  if (trimmed.startsWith('AND(') && trimmed.endsWith(')')) {
    const args = splitTopLevelArgs(trimmed.slice(4, -1));
    return args.every((arg) => evaluateFormula(record, arg));
  }

  if (trimmed.startsWith('OR(') && trimmed.endsWith(')')) {
    const args = splitTopLevelArgs(trimmed.slice(3, -1));
    return args.some((arg) => evaluateFormula(record, arg));
  }

  if (trimmed.startsWith('NOT(') && trimmed.endsWith(')')) {
    const arg = trimmed.slice(4, -1).trim();
    return !evaluateFormula(record, arg);
  }

  const isSameMatch = trimmed.match(/^IS_SAME\((.+?),\s*TODAY\(\),\s*'day'\)$/i);
  if (isSameMatch) {
    const fieldValue = resolveField(record, isSameMatch[1]);
    const today = new Date().toISOString().slice(0, 10);
    return String(fieldValue).slice(0, 10) === today;
  }

  const createdTimeMatch = trimmed.match(/^IS_SAME\(CREATED_TIME\(\),\s*TODAY\(\),\s*'day'\)$/i);
  if (createdTimeMatch) {
    const createdAt = String(record.fields['created_at'] || record.fields['Created At'] || '');
    const today = new Date().toISOString().slice(0, 10);
    return createdAt.slice(0, 10) === today;
  }

  const isAfterMatch = trimmed.match(/^IS_AFTER\((.+?),\s*'(.+?)'\)$/i);
  if (isAfterMatch) {
    const lhs = resolveField(record, isAfterMatch[1]);
    return String(lhs) > isAfterMatch[2];
  }

  const isBeforeMatch = trimmed.match(/^IS_BEFORE\((.+?),\s*'(.+?)'\)$/i);
  if (isBeforeMatch) {
    const lhs = resolveField(record, isBeforeMatch[1]);
    return String(lhs) < isBeforeMatch[2];
  }

  const searchMatch = trimmed.match(/^SEARCH\((['"])(.*)\1,\s*(.+)\)$/i);
  if (searchMatch) {
    const needle = searchMatch[2].toLowerCase();
    const haystack = normalizeFormulaValue(resolveField(record, searchMatch[3]));
    return String(haystack).toLowerCase().includes(needle);
  }

  const findMatch = trimmed.match(/^FIND\((['"])(.*?)\1,\s*ARRAYJOIN\((.+)\)\)$/i);
  if (findMatch) {
    const needle = findMatch[2].toLowerCase();
    const haystack = normalizeFormulaValue(resolveField(record, findMatch[3]));
    return String(haystack).toLowerCase().includes(needle);
  }

  const comparisonMatch = trimmed.match(/^(.+?)\s*(=|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (comparisonMatch) {
    const leftRaw = comparisonMatch[1].trim();
    const operator = comparisonMatch[2];
    const rightRaw = comparisonMatch[3].trim();

    const leftValue = resolveField(record, leftRaw);
    const rightValue = rightRaw.startsWith('{') ? resolveField(record, rightRaw) : unwrapQuotes(rightRaw);
    return compareValues(leftValue, rightValue, operator);
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return Boolean(resolveField(record, trimmed));
  }

  return false;
}

function sortRecords(records: AirtableRecord[], sort?: Array<{ field: string; direction: 'asc' | 'desc' }>): AirtableRecord[] {
  if (!sort || sort.length === 0) return records;
  return [...records].sort((a, b) => {
    for (const { field, direction } of sort) {
      const left = normalizeFormulaValue(a.fields[field]);
      const right = normalizeFormulaValue(b.fields[field]);
      if (String(left) < String(right)) return direction === 'asc' ? -1 : 1;
      if (String(left) > String(right)) return direction === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

class SupabaseSelectWrapper {
  constructor(
    private readonly tableName: string,
    private readonly options?: SelectOptions
  ) {}

  async firstPage(): Promise<AirtableRecord[]> {
    const client = requireSupabase();
    const selectString = buildSelectString(this.options?.fields);
    const resp = await client.from(this.tableName).select(selectString);
    if (resp.error) throw resp.error;
    const rows = (resp.data ?? []) as unknown as Record<string, unknown>[];

    let records = rows.map(rowToAirtableRecord);

    if (this.options?.filterByFormula) {
      const formula = this.options.filterByFormula;
      records = records.filter((record) => evaluateFormula(record, formula));
    }

    const sorted = sortRecords(records, this.options?.sort);
    const limited = this.options?.maxRecords ? sorted.slice(0, this.options.maxRecords) : sorted;
    return limited;
  }

  async eachPage(
    pageFn: (records: AirtableRecord[], fetchNextPage: () => void) => void,
    doneFn: (err?: Error) => void
  ): Promise<void> {
    try {
      const page = await this.firstPage();
      pageFn(page, () => {
        /* no-op: entire result returned in one page */
      });
      doneFn();
    } catch (error) {
      doneFn(error instanceof Error ? error : new Error('Supabase select failed'));
    }
  }
}

export class SupabaseTableWrapper {
  constructor(public readonly name: string) {}

  select(options?: SelectOptions) {
    return new SupabaseSelectWrapper(this.name, options);
  }

  async find(id: string): Promise<AirtableRecord> {
    const client = requireSupabase();
    const resp = await client.from(this.name).select('*').eq('id', id).single();
    if (resp.error) throw resp.error;
    if (!resp.data) throw new Error(`Record not found in ${this.name}: ${id}`);
    return rowToAirtableRecord(resp.data as Record<string, unknown>);
  }

  async create(fields: Partial<Record<string, unknown>> | Array<Record<string, unknown>>): Promise<AirtableRecord | AirtableRecord[]> {
    const client = requireSupabase();
    const payload = Array.isArray(fields) ? fields : [fields];
    const response = await client.from(this.name).insert(payload).select('*');
    if (response.error) throw response.error;
    const data = (response.data ?? []) as unknown as Record<string, unknown>[];
    return Array.isArray(fields)
      ? data.map(rowToAirtableRecord)
      : rowToAirtableRecord(data[0]);
  }

  async update(
    recordIdOrRecords: string | Array<{ id: string; fields: Record<string, unknown> }>,
    fields?: Partial<Record<string, unknown>>
  ): Promise<AirtableRecord | AirtableRecord[]> {
    const client = requireSupabase();

    if (typeof recordIdOrRecords === 'string') {
      const response = await client.from(this.name).update(fields ?? {}).eq('id', recordIdOrRecords).select('*').single();
      if (response.error) throw response.error;
      return rowToAirtableRecord(response.data as Record<string, unknown>);
    }

    const results: AirtableRecord[] = [];
    for (const item of recordIdOrRecords) {
      const response = await client
        .from(this.name)
        .update(item.fields)
        .eq('id', item.id)
        .select('*')
        .single();
      if (response.error) throw response.error;
      results.push(rowToAirtableRecord(response.data as Record<string, unknown>));
    }
    return results;
  }

  async destroy(recordIdOrIds: string | string[]): Promise<void> {
    const client = requireSupabase();
    const query = client.from(this.name).delete();
    if (Array.isArray(recordIdOrIds)) {
      query.in('id', recordIdOrIds);
    } else {
      query.eq('id', recordIdOrIds);
    }
    const response = await query;
    if (response.error) throw response.error;
  }
}

export function getSupabaseTable(tableName: string): SupabaseTableWrapper {
  return new SupabaseTableWrapper(tableName);
}
