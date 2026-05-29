import { z } from 'zod';

/**
 * Centralized environment variable validation for RaniOS.
 *
 * Required vars will throw at build / startup if missing.
 * Optional vars default to empty strings and are checked at call-sites.
 */

/* ── Schema ─────────────────────────────────────────────────── */

const envBaseSchema = z.object({
    // Database credentials - either Airtable or Supabase must be configured
    AIRTABLE_PAT: z.string().optional().default(''),
    AIRTABLE_BASE_ID: z.string().optional().default(''),
    SUPABASE_URL: z.string().optional().default(''),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
    DASHBOARD_JWT_SECRET: z.string().min(1, 'DASHBOARD_JWT_SECRET is required'),

    // Required for AI features
    ANTHROPIC_API_KEY: z.string().optional().default(''),

    // Email
    RESEND_API_KEY: z.string().optional().default(''),
    CONTACT_EMAIL: z.string().optional().default('info@ranibeautyclinic.com'),
    FROM_EMAIL: z
      .string()
      .optional()
      .default('Rani Beauty Clinic <noreply@ranibeautyclinic.com>'),

    // SMS (Twilio)
    TWILIO_ACCOUNT_SID: z.string().optional().default(''),
    TWILIO_AUTH_TOKEN: z.string().optional().default(''),
    TWILIO_FROM_NUMBER: z.string().optional().default(''),

    // Payments
    STRIPE_SECRET_KEY: z.string().optional().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
    CHERRY_API_KEY: z.string().optional().default(''),
    CHERRY_WEBHOOK_SECRET: z.string().optional().default(''),
    PATIENTFI_API_KEY: z.string().optional().default(''),
    PATIENTFI_WEBHOOK_SECRET: z.string().optional().default(''),

    // Booking (webhook-only — Mangomint has no public API)
    MANGOMINT_WEBHOOK_SECRET: z.string().optional().default(''),

    // Automation
    N8N_WEBHOOK_URL: z.string().optional().default(''),

    // Banking
    PLAID_CLIENT_ID: z.string().optional().default(''),
    PLAID_SECRET: z.string().optional().default(''),
    PLAID_ENV: z.string().optional().default('sandbox'),

    // Vector DB / Embeddings
    PINECONE_API_KEY: z.string().optional().default(''),
    VOYAGE_API_KEY: z.string().optional().default(''),
    OPENAI_API_KEY: z.string().optional().default(''),

    // Voice AI
    VAPI_API_KEY: z.string().optional().default(''),
    VAPI_ASSISTANT_ID: z.string().optional().default(''),
    ELEVENLABS_VOICE_ID: z.string().optional().default(''),

    // Ads
    META_ACCESS_TOKEN: z.string().optional().default(''),
    META_AD_ACCOUNT_ID: z.string().optional().default(''),

    // Integrations
    SQUARE_ACCESS_TOKEN: z.string().optional().default(''),
    JOTFORM_API_KEY: z.string().optional().default(''),

    // WordPress
    WORDPRESS_ORIGIN: z.string().optional().default(''),

    // Dashboard users JSON
    DASHBOARD_USERS: z.string().optional().default('{}'),

    // Security / Automation secrets
    CRON_SECRET: z.string().optional().default(''),
    N8N_API_KEY: z.string().optional().default(''),

    // Public runtime URLs / request policy
    NEXT_PUBLIC_BASE_URL: z.string().optional().default('https://www.ranibeautyclinic.com'),
    NEXT_PUBLIC_SITE_URL: z.string().optional().default('https://ranibeautyclinic.com'),
    CORS_ALLOWED_ORIGINS: z.string().optional().default(''),

    // External services
    REPLICATE_API_TOKEN: z.string().optional().default(''),
    HTML2PDF_API_KEY: z.string().optional().default(''),
  });

const envSchema = envBaseSchema.refine((data) => {
  const hasAirtable = Boolean(data.AIRTABLE_PAT && data.AIRTABLE_BASE_ID);
  const hasSupabase = Boolean(data.SUPABASE_URL && data.SUPABASE_SERVICE_ROLE_KEY);
  return hasAirtable || hasSupabase;
}, {
  message: 'Either Airtable credentials or Supabase URL + SERVICE_ROLE_KEY must be configured',
});

/* ── Parse & export ─────────────────────────────────────────── */

/**
 * During `next build`, env vars aren't available so we fall back to a
 * permissive schema that defaults everything to empty strings.
 * At runtime the strict schema is used and will throw on missing required vars.
 */
const isBuildPhase =
  process.env.NEXT_PHASE === 'phase-production-build' ||
  process.env.npm_lifecycle_event === 'build';

const buildSafeSchema = envBaseSchema.extend({
  DASHBOARD_JWT_SECRET: z.string().optional().default(''),
});

function validateEnv() {
  const schema = isBuildPhase ? buildSafeSchema : envSchema;
  const result = schema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ✗ ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    console.error(
      '\n╔══════════════════════════════════════════════╗\n' +
        '║  ⚠ Missing required environment variables    ║\n' +
        '╚══════════════════════════════════════════════╝\n' +
        formatted +
        '\n\nSee .env.example for reference.\n'
    );

    throw new Error(`Environment validation failed:\n${formatted}`);
  }

  return result.data;
}

/** Lazy-initialised env — avoids crashing at import time during `next build`. */
let _env: ReturnType<typeof validateEnv> | null = null;
function getEnv() {
  if (!_env) _env = validateEnv();
  return _env;
}

/**
 * Proxy-backed env export. Defers validation until first property access,
 * so the module can be imported during `next build` without crashing.
 */
export const env = new Proxy({} as ReturnType<typeof validateEnv>, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof ReturnType<typeof validateEnv>];
  },
});

/* ── Helper: check if an optional feature is configured ─────── */

export const hasFeature = {
  ai: () => Boolean(env.ANTHROPIC_API_KEY),
  email: () => Boolean(env.RESEND_API_KEY),
  sms: () =>
    Boolean(
      env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_AUTH_TOKEN &&
        env.TWILIO_FROM_NUMBER
    ),
  stripe: () => Boolean(env.STRIPE_SECRET_KEY),
  cherry: () => Boolean(env.CHERRY_API_KEY),
  patientfi: () => Boolean(env.PATIENTFI_API_KEY),
  plaid: () => Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
  pinecone: () => Boolean(env.PINECONE_API_KEY),
  embeddings: () => Boolean(env.VOYAGE_API_KEY || env.OPENAI_API_KEY),
  vapi: () => Boolean(env.VAPI_API_KEY && env.VAPI_ASSISTANT_ID),
  voiceClone: () => Boolean(env.ELEVENLABS_VOICE_ID),
  supabase: () => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
  metaAds: () => Boolean(env.META_ACCESS_TOKEN && env.META_AD_ACCOUNT_ID),
  n8n: () => Boolean(env.N8N_WEBHOOK_URL),
} as const;
