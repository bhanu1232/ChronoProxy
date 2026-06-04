/**
 * db.ts — PostgreSQL Credential Vault
 *
 * Stores and retrieves API credentials with AES-256-GCM encryption at rest.
 * The encryption key is loaded from the ENCRYPTION_KEY environment variable
 * (32-byte hex string) and NEVER written to the database.
 *
 * Schema (auto-created on first connect):
 *   CREATE TABLE api_credentials (
 *     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     service      TEXT NOT NULL UNIQUE,
 *     ciphertext   TEXT NOT NULL,      -- base64(iv + authTag + ciphertext)
 *     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 */

import { Pool, PoolClient } from 'pg';
import crypto from 'crypto';

// ── Encryption Config ─────────────────────────────────────────────────────────
const ALGORITHM   = 'aes-256-gcm';
const IV_BYTES    = 12;   // 96-bit IV recommended for GCM
const TAG_BYTES   = 16;   // 128-bit authentication tag

function getEncryptionKey(): Buffer {
  const hexKey = process.env['ENCRYPTION_KEY'] ?? '';
  if (hexKey.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hexKey, 'hex');
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: [iv(12)] + [tag(16)] + [ciphertext(N)]
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(packed: string): string {
  const key  = getEncryptionKey();
  const blob = Buffer.from(packed, 'base64');
  const iv   = blob.subarray(0, IV_BYTES);
  const tag  = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

// ── Database Pool ─────────────────────────────────────────────────────────────

let pgPool: Pool | null = null;

function getPool(): Pool {
  if (!pgPool) {
    pgPool = new Pool({
      host:     process.env['PG_HOST']     ?? '127.0.0.1',
      port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
      database: process.env['PG_DATABASE'] ?? 'semantic_proxy',
      user:     process.env['PG_USER']     ?? 'proxy_user',
      password: process.env['PG_PASSWORD'] ?? '',
      max:      5,            // Small pool; we are not a DB-heavy service
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pgPool;
}

// ── Schema Bootstrap ──────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS api_credentials (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service     TEXT NOT NULL UNIQUE,
    ciphertext  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION update_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS set_updated_at ON api_credentials;
  CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON api_credentials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

export async function bootstrapSchema(): Promise<void> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  try {
    await client.query(CREATE_TABLE_SQL);
    console.log('[db] Schema bootstrapped');
  } finally {
    client.release();
  }
}

// ── CRUD Operations ───────────────────────────────────────────────────────────

/** Store or update an API credential for a named service. */
export async function upsertCredential(service: string, apiKey: string): Promise<void> {
  const pool       = getPool();
  const ciphertext = encrypt(apiKey);
  await pool.query(
    `INSERT INTO api_credentials (service, ciphertext)
     VALUES ($1, $2)
     ON CONFLICT (service) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
    [service, ciphertext],
  );
}

/** Retrieve and decrypt a credential. Returns null if not found. */
export async function getCredential(service: string): Promise<string | null> {
  const pool   = getPool();
  const result = await pool.query<{ ciphertext: string }>(
    'SELECT ciphertext FROM api_credentials WHERE service = $1',
    [service],
  );
  if (result.rows.length === 0) return null;
  return decrypt(result.rows[0].ciphertext);
}

/** Delete a credential. */
export async function deleteCredential(service: string): Promise<boolean> {
  const pool   = getPool();
  const result = await pool.query(
    'DELETE FROM api_credentials WHERE service = $1',
    [service],
  );
  return (result.rowCount ?? 0) > 0;
}

/** List all registered service names (no keys — never log secrets). */
export async function listServices(): Promise<string[]> {
  const pool   = getPool();
  const result = await pool.query<{ service: string }>(
    'SELECT service FROM api_credentials ORDER BY created_at',
  );
  return result.rows.map((r) => r.service);
}

/** Graceful shutdown */
export async function closeDb(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
}
