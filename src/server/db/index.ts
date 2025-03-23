import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import dbConfig from "../../../drizzle.config";
import * as schema from "./schema";

const pool = new Pool({
  ...dbConfig.dbCredentials,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });
