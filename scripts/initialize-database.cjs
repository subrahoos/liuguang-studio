/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

function initializeDatabase({ dataRoot, adminPassword, seedChannels = true }) {
  if (!dataRoot) throw new Error("A data root is required");
  const system = path.join(path.resolve(dataRoot), "system");
  fs.mkdirSync(system, { recursive: true });
  const db = new Database(path.join(system, "sqlite.db"));
  try {
    const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n === 0;
    if (empty) {
      if (!adminPassword || adminPassword.length < 12) throw new Error("首次安装请设置至少 12 位管理员密码");
      db.transaction(() => {
        db.exec(fs.readFileSync(path.join(__dirname, "../deployment/schema.sql"), "utf8").replace(/^\uFEFF/, ""));
        db.exec(fs.readFileSync(path.join(__dirname, "../deployment/board-store-schema.sql"), "utf8"));
        const salt = crypto.randomBytes(16).toString("hex");
        const hash = crypto.pbkdf2Sync(adminPassword, salt, 210000, 32, "sha256").toString("hex");
        const now = Date.now();
        db.prepare("INSERT INTO auth_users (id,account_id,username,password_hash,role,disabled,created_at,updated_at) VALUES (?,?,?,?, 'admin',0,?,?)")
          .run("luma-admin", "LUMA-000001", "admin", `pbkdf2$210000$${salt}$${hash}`, now, now);
        if (seedChannels) {
          const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployment/model-channels.json"), "utf8"));
          const insert = db.prepare("INSERT INTO model_channels (id,kind,provider_key,name,enabled,base_url,model,config,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
          for (const row of seed.channels) insert.run(row.id,row.kind,row.provider_key,row.name,row.enabled,row.base_url,row.model,JSON.stringify(row.config),row.sort_order,now,now);
        }
      })();
    }
    const keyFile = path.join(system, "model-credential-encryption.key");
    if (!fs.existsSync(keyFile)) {
      const hasCredentials = ["user_model_credentials", "user_video_reference_hosting_credentials"].some(table =>
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
      if (hasCredentials) throw new Error("数据库已有加密凭证但缺少本机主密钥，请恢复原密钥后启动");
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
    }
    const watermarkKeyFile = path.join(system, "metadata-watermark.key");
    if (!fs.existsSync(watermarkKeyFile)) fs.writeFileSync(watermarkKeyFile, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    db.pragma("foreign_keys = ON");
    if (db.pragma("foreign_key_check").length) throw new Error("Database foreign-key check failed");
    return { created: empty, tables: db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n };
  } finally { db.close(); }
}

module.exports = { initializeDatabase };
if (require.main === module) {
  const result = initializeDatabase({ dataRoot: process.env.LUMA_DATA_ROOT, adminPassword: process.env.LUMA_ADMIN_PASSWORD });
  console.log(JSON.stringify(result));
}
