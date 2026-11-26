/* eslint-disable @typescript-eslint/no-require-imports */
// Exercises a production build with an ephemeral database. Never opens business data.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initializeDatabase } = require("./initialize-database.cjs");
const root = path.resolve(__dirname, "..");

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luma-security-http-"));
  const password = crypto.randomBytes(24).toString("base64url");
  initializeDatabase({ dataRoot, adminPassword: password, seedChannels: false });
  const db = new Database(path.join(dataRoot, "system/sqlite.db"));
  const hash = db.prepare("SELECT password_hash FROM auth_users WHERE id='luma-admin'").get().password_hash;
  for (const id of ["security-a", "security-b"]) {
    db.prepare("INSERT INTO auth_users(id,account_id,username,password_hash,role,disabled) VALUES(?,?,?,?,'user',0)").run(id, id, id, hash);
  }
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const key = (await fs.readFile(path.join(dataRoot, "system/model-credential-encryption.key"), "utf8")).trim();
  const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), LUMA_DATA_ROOT: dataRoot, LUMA_CREDENTIAL_ENCRYPTION_KEY: key,
      LUMA_PUBLIC_ORIGINS: "", LUMA_TRUST_PROXY: "0", LUMA_SECURE_COOKIES: "0", NEXT_TELEMETRY_DISABLED: "1" },
  });
  let logs = ""; let count = 0;
  server.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-20000); });
  server.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-20000); });
  async function check(route, expected, { cookie, method = "GET", body, headers = {} } = {}) {
    const requestHeaders = {
      ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers,
    };
    // Node fetch ignores a custom Host. Use raw HTTP to actually exercise rebinding.
    const response = headers.host ? await new Promise((resolve, reject) => {
      const req = http.request(base + route, { method, headers: requestHeaders }, (res) => {
        const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    }) : await fetch(base + route, { method, redirect: "manual", headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, expected, `${method} ${route}`); count++;
    if (route.startsWith("/api/")) assert.match(response.headers.get("cache-control") || "", /no-store/);
    return response;
  }
  async function login(username) {
    const response = await check("/api/auth/login", 200, { method: "POST", body: { username, password }, headers: { origin: base } });
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    return response.headers.get("set-cookie").split(";")[0];
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error("Isolated server exited before startup");
      try { ready = (await fetch(base)).ok; } catch { /* Startup in progress. */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(ready, "Isolated server did not become ready");
    await check("/", 200);
    for (const route of ["/.env", "/.git/config", "/src/proxy.ts", "/deployment/release.json", "/_next/static/private.js.map", "/data/system/sqlite.db"]) await check(route, 404);
    await check("/workspace", 307, { cookie: "luma_session=forged" });
    await check("/api/quick-cut/tasks", 401);
    await check("/api/home-backgrounds/luma-admin/private.png", 401);
    await check("/api/auth/login", 403, { method: "POST", body: {}, headers: { origin: "https://attacker.example" } });
    await check("/api/auth/login", 403, { method: "POST", body: {}, headers: { host: "attacker.example" } });
    const a = await login("security-a"); const b = await login("security-b"); const admin = await login("admin");
    const page = await check("/workspace", 200, { cookie: a });
    const html = await page.text();
    const assets = new Set([...html.matchAll(/(?:src|href)="([^"\s]+\.(?:css|js)(?:\?[^"\s]*)?)"/g)].map((m) => m[1]).filter((v) => v.startsWith("/_next/")));
    assert(assets.size > 0, "No rendered CSS/JS assets");
    for (const asset of assets) await check(asset, 200);
    for (const endpoint of ["/api/auth/me", "/api/project", "/api/products", "/api/board-workflows", "/api/quick-cut/tasks", "/api/identity-pack"]) await check(endpoint, 200, { cookie: a });
    await check("/api/model-settings", 403, { cookie: a });
    await check("/api/model-settings", 200, { cookie: admin });
    await check("/api/admin/users", 403, { cookie: a });
    await check("/api/model-identity/main-model-v2.png", 403, { cookie: a });
    await check("/api/auth/me", 200, { cookie: a, headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.1" } });
    const workflow = (await (await check("/api/board-workflows", 200, { cookie: a, method: "POST", body: { name: "security-test" } })).json()).workflow;
    await fs.writeFile(path.join(workflow.localDir, "private.png"), "private-a");
    assert.equal(await (await check(`/api/board-workflows/${workflow.id}/file/private.png`, 200, { cookie: a })).text(), "private-a");
    await check(`/api/board-workflows/${workflow.id}/file/private.png`, 404, { cookie: b });
    await check(`/api/board-workflows/${workflow.id}`, 404, { cookie: b });
    await check(`/api/board-workflows/${workflow.id}`, 403, { cookie: a, method: "PATCH", body: {}, headers: { origin: "https://attacker.example" } });
    await check("/api/ai/status", 404, { cookie: b, method: "POST", body: { provider: "fal-ai", taskId: "foreign-task", videoChannelId: "foreign-channel" } });
    const backgroundDir = path.join(dataRoot, "backgrounds", "luma-admin");
    await fs.mkdir(backgroundDir, { recursive: true });
    await fs.writeFile(path.join(backgroundDir, "private.png"), "admin-private");
    await check("/api/home-backgrounds/luma-admin/private.png", 200, { cookie: admin });
    await check("/api/home-backgrounds/luma-admin/private.png", 404, { cookie: b });
    await check("/api/admin/users/security-a", 200, { cookie: admin, method: "PATCH", body: { disabled: true } });
    await check("/api/admin/users/security-a", 200, { cookie: admin, method: "PATCH", body: { disabled: false } });
    await check("/api/auth/me", 401, { cookie: a });
    for (let i = 0; i < 9; i++) await check("/api/auth/login", i < 8 ? 401 : 429, {
      method: "POST", body: { username: "does-not-exist", password: "wrong" }, headers: { "x-forwarded-for": `203.0.113.${i}` },
    });
    console.log(JSON.stringify({ passed: count, assets: assets.size, isolated: true, paidCalls: 0 }));
  } catch (error) {
    // Diagnostics contain no passwords or cookie values; keep server logs local.
    await fs.writeFile(path.join(dataRoot, "server.log"), logs);
    console.error(`Security verification failed; isolated diagnostics: ${dataRoot}`);
    throw error;
  } finally {
    server.kill(); await once(server, "exit").catch(() => {}); db.close();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
