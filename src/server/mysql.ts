import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "path";
import { isProductionRuntimeEnv } from "./payments.ts";

try {
  dotenv.config();
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env.production") });
} catch (_e) {
  // Ignore
}

export interface DbConfig {
  host?: string | undefined;
  port: number;
  database?: string | undefined;
  user?: string | undefined;
  password?: string | undefined;
  isConfigured: boolean;
}

function readDbEnv(
  key: string,
  env?: Record<string, string | undefined> | undefined,
): string | undefined {
  if (env !== undefined && Object.prototype.hasOwnProperty.call(env, key)) {
    return env[key];
  }
  return process.env[key];
}

export function getDbConfig(env?: Record<string, string | undefined> | undefined): DbConfig {
  const host = readDbEnv("DB_HOST", env) || readDbEnv("MYSQL_HOST", env);
  const port = Number(readDbEnv("DB_PORT", env) || readDbEnv("MYSQL_PORT", env) || 3306);
  const database = readDbEnv("DB_NAME", env) || readDbEnv("MYSQL_DATABASE", env);
  const user = readDbEnv("DB_USER", env) || readDbEnv("MYSQL_USER", env);
  const password = readDbEnv("DB_PASSWORD", env) || readDbEnv("MYSQL_PASSWORD", env) || "";

  // Verify that required connection parameters exist
  const isConfigured = Boolean(host && database && user);

  return {
    host,
    port,
    database,
    user,
    password,
    isConfigured,
  };
}

let pool: mysql.Pool | null = null;
let testingPoolOverride = false;
let poolConfigKey = "";

export function getMysqlPool(
  env?: Record<string, string | undefined> | undefined,
): mysql.Pool | null {
  const conf = getDbConfig(env);
  if (testingPoolOverride && pool) {
    const hasExplicitHostOverride =
      env !== undefined &&
      (Object.prototype.hasOwnProperty.call(env, "DB_HOST") ||
        Object.prototype.hasOwnProperty.call(env, "MYSQL_HOST"));
    if (hasExplicitHostOverride && !conf.isConfigured) {
      return null;
    }
    return pool;
  }

  if (!conf.isConfigured || !conf.host || !conf.database || !conf.user) {
    return null;
  }

  const nextKey = `${conf.host}:${conf.port}:${conf.database}:${conf.user}:${conf.password ?? ""}`;
  if (!pool || poolConfigKey !== nextKey) {
    try {
      pool = mysql.createPool({
        host: conf.host,
        port: conf.port,
        user: conf.user,
        password: conf.password || "",
        database: conf.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      });
      poolConfigKey = nextKey;
    } catch (err) {
      if (isProductionRuntimeEnv(env)) {
        console.error(
          "[FaceTube] MySQL pool creation failed in production — JSON fallback disabled",
          err,
        );
      } else {
        console.warn("[AI Studio] MySQL pool creation failed — fallback store active", err);
      }
      return null;
    }
  }

  return pool;
}

export function setMysqlPoolForTesting(mockPool: any): void {
  pool = mockPool;
  testingPoolOverride = mockPool !== null;
  poolConfigKey = "";
}

/**
 * Verifies live MySQL connection health and returns safe diagnostics
 */
export async function testDatabaseConnection(
  env?: Record<string, string | undefined> | undefined,
): Promise<{
  connected: boolean;
  error?: string | undefined;
  host?: string | undefined;
  database?: string | undefined;
  user?: string | undefined;
}> {
  const conf = getDbConfig(env);
  if (!conf.isConfigured) {
    return {
      connected: false,
      error:
        "MySQL configuration missing. Please define DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD in .env",
      host: conf.host || "NOT_SET",
      database: conf.database || "NOT_SET",
      user: conf.user || "NOT_SET",
    };
  }

  try {
    const p = getMysqlPool(env);
    if (!p) throw new Error("Could not initialize MySQL connection pool");
    const connection = await p.getConnection();
    try {
      await connection.ping();
      return {
        connected: true,
        host: conf.host,
        database: conf.database,
        user: conf.user ? `${conf.user.slice(0, 3)}***` : "SET",
      };
    } finally {
      connection.release();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      error: `MySQL connection failed: ${msg}`,
      host: conf.host,
      database: conf.database,
      user: conf.user,
    };
  }
}
