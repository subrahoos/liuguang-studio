import { existsSync, mkdirSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";

const root = join(tmpdir(), `luma-3100-vitest-${process.pid}`);

mkdirSync(root, { recursive: true });
process.env.LUMA_DATA_ROOT = root;
process.env.LUMA_ADMIN_PASSWORD = "vitest-local-only-password";
process.env.LUMA_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const require = createRequire(import.meta.url);
const { initializeDatabase } = require("./scripts/initialize-database.cjs");
if (!existsSync(join(root, "system", "sqlite.db"))) {
  initializeDatabase({ dataRoot: root, adminPassword: process.env.LUMA_ADMIN_PASSWORD, seedChannels: false });
}
