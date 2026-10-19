import { z } from 'zod';

const databaseUrlSchema = z.string().url().refine((value) => /^postgres(?:ql)?:\/\//i.test(value), 'DATABASE_URL must be a PostgreSQL URL');
let poolPromise: Promise<any> | null = null;

/** Lazy pool creation: importing the server never opens a database connection. */
export async function getPool(): Promise<any> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  const connectionString = databaseUrlSchema.parse(process.env.DATABASE_URL);
  if (!poolPromise) {
    poolPromise = import('pg').then(({ Pool }) => new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX) || 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    }));
  }
  return poolPromise;
}

export async function checkDatabase(): Promise<boolean> {
  try {
    const pool = await getPool();
    await pool.query('SELECT 1');
    // A configured database is not ready until the BX-04 schema migration has
    // been applied. This also prevents a partially configured deployment from
    // appearing healthy merely because PostgreSQL accepts SELECT 1.
    const migrationTable = await pool.query("SELECT to_regclass('public.schema_migrations') AS table_name");
    if (!migrationTable.rows[0]?.table_name) return false;
    const migration = await pool.query("SELECT 1 FROM schema_migrations WHERE version = '001_project_state'");
    if (!migration.rowCount) return false;
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => null);
  poolPromise = null;
  if (pool) await pool.end();
}
