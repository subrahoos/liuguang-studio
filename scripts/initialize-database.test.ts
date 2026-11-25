// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { initializeDatabase } = require("./initialize-database.cjs");

it("creates a complete empty installation with public channels and preserves its independent keys and password", () => {
  const root = mkdtempSync(path.join(tmpdir(), "luma-fresh-install-"));
  try {
    const first = initializeDatabase({ dataRoot: root, adminPassword: "fresh-install-test-password" });
    expect(first.created).toBe(true);
    const credentialKey = readFileSync(path.join(root, "system/model-credential-encryption.key"), "utf8");
    const watermarkKey = readFileSync(path.join(root, "system/metadata-watermark.key"), "utf8");
    expect(Buffer.from(credentialKey, "base64")).toHaveLength(32);
    expect(Buffer.from(watermarkKey, "hex")).toHaveLength(32);
    const db = new Database(path.join(root, "system/sqlite.db"));
    const passwordHash = db.prepare("SELECT password_hash FROM auth_users WHERE id='luma-admin'").get();
    try {
      expect(db.prepare("SELECT count(*) AS n FROM model_channels").get()).toEqual({ n: 10 });
      for (const table of ["projects", "board_workflows", "product_production_tasks", "quick_cut_tasks", "analytics_imports", "user_model_credentials", "auth_sessions"]) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally { db.close(); }
    expect(initializeDatabase({ dataRoot: root, adminPassword: "different-test-password" }).created).toBe(false);
    expect(readFileSync(path.join(root, "system/model-credential-encryption.key"), "utf8")).toBe(credentialKey);
    expect(readFileSync(path.join(root, "system/metadata-watermark.key"), "utf8")).toBe(watermarkKey);
    const reopened = new Database(path.join(root, "system/sqlite.db"));
    try { expect(reopened.prepare("SELECT password_hash FROM auth_users WHERE id='luma-admin'").get()).toEqual(passwordHash); }
    finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
