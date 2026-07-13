import { loadConfig } from "./config.js";
import { createPool, runMigrations } from "./db.js";

const config = loadConfig();
const pool = createPool(config);

try {
  await runMigrations(pool);
  console.log("Database migrations are current");
} finally {
  await pool.end();
}
