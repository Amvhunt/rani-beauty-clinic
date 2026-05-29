import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('env validation', () => {
  const REQUIRED = {
    AIRTABLE_PAT: 'pat_test123',
    AIRTABLE_BASE_ID: 'app123',
    DASHBOARD_JWT_SECRET: 'supersecret',
  };

  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when AIRTABLE_PAT is missing', async () => {
    vi.stubEnv('AIRTABLE_PAT', '');
    vi.stubEnv('AIRTABLE_BASE_ID', 'app123');
    vi.stubEnv('DASHBOARD_JWT_SECRET', 'secret');

    const mod = await import('./env');
    expect(() => mod.env.AIRTABLE_PAT).toThrow('Environment validation failed');
  });

  it('throws when DASHBOARD_JWT_SECRET is missing', async () => {
    vi.stubEnv('AIRTABLE_PAT', 'pat_test');
    vi.stubEnv('AIRTABLE_BASE_ID', 'app123');
    vi.stubEnv('DASHBOARD_JWT_SECRET', '');

    const mod = await import('./env');
    expect(() => mod.env.DASHBOARD_JWT_SECRET).toThrow('Environment validation failed');
  });

  it('succeeds with all required vars', async () => {
    Object.entries(REQUIRED).forEach(([k, v]) => vi.stubEnv(k, v));

    const mod = await import('./env');
    expect(mod.env.AIRTABLE_PAT).toBe('pat_test123');
    expect(mod.env.AIRTABLE_BASE_ID).toBe('app123');
  });

  it('succeeds when Supabase is configured instead of Airtable', async () => {
    vi.stubEnv('AIRTABLE_PAT', '');
    vi.stubEnv('AIRTABLE_BASE_ID', '');
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service_role_test');
    vi.stubEnv('DASHBOARD_JWT_SECRET', 'supersecret');

    const mod = await import('./env');
    expect(mod.env.SUPABASE_URL).toBe('https://test.supabase.co');
    expect(mod.env.SUPABASE_SERVICE_ROLE_KEY).toBe('service_role_test');
  });

  it('defaults optional vars to empty strings', async () => {
    Object.entries(REQUIRED).forEach(([k, v]) => vi.stubEnv(k, v));

    const mod = await import('./env');
    expect(mod.env.STRIPE_SECRET_KEY).toBe('');
    expect(mod.env.VOYAGE_API_KEY).toBe('');
  });

  it('hasFeature helpers work correctly', async () => {
    Object.entries(REQUIRED).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    const mod = await import('./env');
    expect(mod.hasFeature.ai()).toBe(true);
    expect(mod.hasFeature.stripe()).toBe(false);
  });
});
