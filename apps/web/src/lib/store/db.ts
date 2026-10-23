import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Database access. PostgreSQL when DATABASE_URL is set (production, e.g. Neon via the
 * Vercel Marketplace); otherwise embedded PostgreSQL (PGlite, WASM) persisted under
 * .data/ locally, or under /tmp on serverless hosts where that storage is ephemeral.
 * Both run the same SQL migrations.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  kind: "postgres" | "pglite";
  location: string;
  ephemeral: boolean;
}

let dbPromise: Promise<Db> | null = null;

export function migrationsDir(): string {
  return process.env.DEVIN_MIGRATIONS_DIR ?? path.join(process.cwd(), "migrations");
}

async function migrate(db: Db): Promise<void> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir(), file), "utf8");
    for (const stmt of sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
      await db.query(stmt);
    }
    await db.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
  }
}

async function openPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 3, prepare: false, idle_timeout: 20, onnotice: () => {} });
  return {
    kind: "postgres",
    location: url.replace(/\/\/[^@]*@/, "//***@"),
    ephemeral: false,
    async query<T>(text: string, params: unknown[] = []) {
      const values = params.map((p) => (p !== null && typeof p === "object" ? JSON.stringify(p) : p));
      return (await sql.unsafe(text, values as never[])) as unknown as T[];
    },
  };
}

async function openPglite(dir: string | null): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir) mkdirSync(dir, { recursive: true });
  const pg = dir ? new PGlite(dir) : new PGlite();
  await pg.waitReady;
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return {
    kind: "pglite",
    location: dir ?? "memory",
    ephemeral: !dir || serverless,
    async query<T>(text: string, params: unknown[] = []) {
      const res = await pg.query(text, params.map((p) => (p !== null && typeof p === "object" ? JSON.stringify(p) : p)));
      return res.rows as T[];
    },
  };
}

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      let db: Db;
      if (process.env.DATABASE_URL) db = await openPostgres(process.env.DATABASE_URL);
      else if (process.env.DEVIN_DB === "memory") db = await openPglite(null);
      else {
        const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
        const dir = process.env.DEVIN_PGLITE_DIR ?? (serverless ? "/tmp/devin-vlsi-pglite" : path.join(process.cwd(), ".data", "pglite"));
        db = await openPglite(dir);
      }
      await migrate(db);
      return db;
    })().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/** For tests: start over with a fresh in-memory database. */
export function resetDbForTests(): void {
  if (process.env.DEVIN_DB !== "memory") throw new Error("resetDbForTests requires DEVIN_DB=memory");
  dbPromise = null;
}

export function migrationsPresent(): boolean {
  return existsSync(migrationsDir());
}
