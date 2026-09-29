import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: config.statementTimeoutMs,
  options: `-c lock_timeout=${config.lockTimeoutMs}`,
});

pool.on("error", (error) => {
  const errorCode = "code" in error ? String(error.code ?? "") : "";
  console.error(JSON.stringify({
    level: "error",
    event: "database_idle_client_error",
    errorType: error.name,
    ...(errorCode ? { errorCode } : {}),
  }));
});

export async function query<T extends import("pg").QueryResultRow>(
  text: string,
  params?: any[]
) {
  return pool.query<T>(text, params);
}
