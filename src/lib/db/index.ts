import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "fs";
import * as schema from "./schema";
import { ADMIN_ACCOUNT_ID, ADMIN_PASSWORD, ADMIN_USER_ID, ADMIN_USERNAME } from "@/lib/auth-constants";
import { hashPassword } from "@/lib/auth-crypto";
import { scheduleStorageMaintenance, storagePaths } from "@/lib/storage-root";

const DB_DIR = storagePaths.system();
const DB_PATH = storagePaths.system("sqlite.db");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Keep one process-wide SQLite handle so modules that need transactional
// persistence share the same WAL connection instead of opening side stores.
export const sqlite = new Database(DB_PATH);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
scheduleStorageMaintenance();

function safeRun(sql: string) {
  try {
    sqlite.prepare(sql).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name|already exists/i.test(message)) throw error;
  }
}

safeRun(`
  CREATE TABLE IF NOT EXISTS auth_users (
    id text PRIMARY KEY,
    account_id text NOT NULL UNIQUE,
    username text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user',
    disabled integer NOT NULL DEFAULT 0,
    created_at integer,
    updated_at integer,
    last_login_at integer
  )
`);

safeRun("CREATE UNIQUE INDEX IF NOT EXISTS auth_users_username_nocase_unique ON auth_users(username COLLATE NOCASE)");

safeRun(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at integer NOT NULL,
    created_at integer
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS auth_invites (
    id text PRIMARY KEY,
    code_hash text NOT NULL UNIQUE,
    label text,
    created_by_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
    used_by_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
    expires_at integer NOT NULL,
    used_at integer,
    created_at integer
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS user_model_settings (
    user_id text PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
    settings text NOT NULL,
    updated_at integer
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS model_channels (
    id text PRIMARY KEY,
    kind text NOT NULL,
    provider_key text NOT NULL,
    name text NOT NULL,
    enabled integer NOT NULL DEFAULT 1,
    base_url text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    config text NOT NULL DEFAULT '{}',
    sort_order integer NOT NULL DEFAULT 0,
    created_at integer,
    updated_at integer
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS user_model_credentials (
    user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    channel_id text NOT NULL REFERENCES model_channels(id) ON DELETE CASCADE,
    encrypted_api_key text NOT NULL,
    key_version integer NOT NULL DEFAULT 1,
    created_at integer,
    updated_at integer,
    PRIMARY KEY (user_id, channel_id)
  )
`);
safeRun("CREATE INDEX IF NOT EXISTS user_model_credentials_channel_idx ON user_model_credentials(channel_id)");

safeRun(`
  CREATE TABLE IF NOT EXISTS user_video_reference_hosting_credentials (
    user_id text PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
    encrypted_api_key text NOT NULL,
    encrypted_api_secret text NOT NULL,
    key_version integer NOT NULL DEFAULT 1,
    created_at integer,
    updated_at integer
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS user_feature_entries (
    user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    feature_key text NOT NULL,
    entry_state text NOT NULL DEFAULT 'open',
    updated_at integer,
    PRIMARY KEY (user_id, feature_key)
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS model_api_calls (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    call_type text NOT NULL,
    provider_key text NOT NULL,
    channel_id text REFERENCES model_channels(id) ON DELETE SET NULL,
    channel_name text,
    model text,
    source text NOT NULL,
    project_id text,
    board_workflow_id text,
    board_node_id text,
    quick_cut_task_id text,
    parent_call_id text REFERENCES model_api_calls(id) ON DELETE SET NULL,
    attempt_number integer NOT NULL DEFAULT 1,
    status text NOT NULL,
    http_status integer,
    remote_task_id text,
    duration_ms integer NOT NULL,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    usage_json text,
    error_code text,
    error_message text,
    created_at integer,
    completed_at integer
  )
`);
safeRun("CREATE INDEX IF NOT EXISTS model_api_calls_user_created_idx ON model_api_calls(user_id, created_at DESC)");
safeRun("CREATE INDEX IF NOT EXISTS model_api_calls_created_idx ON model_api_calls(created_at DESC)");
safeRun("CREATE INDEX IF NOT EXISTS model_api_calls_status_created_idx ON model_api_calls(status, created_at DESC)");
safeRun("CREATE INDEX IF NOT EXISTS model_api_calls_channel_created_idx ON model_api_calls(channel_id, created_at DESC)");
safeRun("ALTER TABLE model_api_calls ADD COLUMN product_production_task_id text");
safeRun("ALTER TABLE model_api_calls ADD COLUMN product_production_job_id text");
safeRun("CREATE INDEX IF NOT EXISTS model_api_calls_product_production_idx ON model_api_calls(product_production_task_id, created_at DESC)");

safeRun(`
  CREATE TABLE IF NOT EXISTS product_production_tasks (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 0,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    payload text NOT NULL DEFAULT '{}',
    created_at integer,
    updated_at integer,
    completed_at integer
  )
`);
safeRun("CREATE INDEX IF NOT EXISTS product_production_owner_updated_idx ON product_production_tasks(owner_id, updated_at DESC)");

safeRun(`
  CREATE TABLE IF NOT EXISTS products (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    description text,
    images text NOT NULL DEFAULT '[]',
    price text,
    target_audience text,
    analysis text,
    usage_scenarios text,
    negative_constraints text,
    video_count integer NOT NULL DEFAULT 0,
    created_at integer,
    updated_at integer
  )
`);

const productColumns = sqlite.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>;
const productColumnNames = new Set(productColumns.map((column) => column.name));
for (const [name, definition] of [
  ["owner_id", `text NOT NULL DEFAULT '${ADMIN_USER_ID}'`],
  ["usage_scenarios", "text"],
  ["negative_constraints", "text"],
  ["updated_at", "integer"],
] as const) {
  if (!productColumnNames.has(name)) safeRun(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
}
safeRun("CREATE INDEX IF NOT EXISTS products_owner_updated_idx ON products(owner_id, updated_at DESC)");

safeRun(`
  CREATE TABLE IF NOT EXISTS quick_cut_tasks (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    source_root text NOT NULL,
    task_root text NOT NULL,
    stage text NOT NULL DEFAULT '等待素材',
    settings text NOT NULL DEFAULT '{}',
    scan text,
    analysis_summary text,
    plans text,
    rows text NOT NULL DEFAULT '[]',
    events text NOT NULL DEFAULT '[]',
    progress integer NOT NULL DEFAULT 0,
    total integer NOT NULL DEFAULT 0,
    completed integer NOT NULL DEFAULT 0,
    failed integer NOT NULL DEFAULT 0,
    error_message text,
    created_at integer,
    updated_at integer,
    completed_at integer
  )
`);
safeRun("ALTER TABLE quick_cut_tasks ADD COLUMN stage text NOT NULL DEFAULT '等待素材'");
safeRun("ALTER TABLE quick_cut_tasks ADD COLUMN events text NOT NULL DEFAULT '[]'");
safeRun("CREATE INDEX IF NOT EXISTS quick_cut_tasks_owner_updated_idx ON quick_cut_tasks(owner_id, updated_at DESC)");

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_imports (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    file_name text NOT NULL,
    file_path text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    created_by text REFERENCES auth_users(id) ON DELETE SET NULL,
    stage text NOT NULL DEFAULT '等待解析',
    progress integer NOT NULL DEFAULT 0,
    period_start text,
    period_end text,
    product_period_start text,
    product_period_end text,
    store_count integer NOT NULL DEFAULT 0,
    product_count integer NOT NULL DEFAULT 0,
    registered_product_count integer NOT NULL DEFAULT 0,
    store_row_count integer NOT NULL DEFAULT 0,
    product_row_count integer NOT NULL DEFAULT 0,
    product_profit_total real NOT NULL DEFAULT 0,
    cached_product_profit_total real NOT NULL DEFAULT 0,
    reconciliation_status text NOT NULL DEFAULT 'fail',
    formula_count integer NOT NULL DEFAULT 0,
    formula_error_count integer NOT NULL DEFAULT 0,
    fixed_range_risk_count integer NOT NULL DEFAULT 0,
    issue_count integer NOT NULL DEFAULT 0,
    source_order_rows integer NOT NULL DEFAULT 0,
    source_order_last_row integer NOT NULL DEFAULT 0,
    source_spend_rows integer NOT NULL DEFAULT 0,
    source_spend_last_row integer NOT NULL DEFAULT 0,
    snapshot_date text,
    maturity_days integer NOT NULL DEFAULT 6,
    error_message text,
    created_at integer,
    previewed_at integer,
    committed_at integer,
    completed_at integer
  )
`);

const analyticsImportColumns = sqlite.prepare("PRAGMA table_info(analytics_imports)").all() as Array<{ name: string }>;
const analyticsImportColumnNames = new Set(analyticsImportColumns.map((column) => column.name));
for (const [name, definition] of [
  ["product_profit_total", "real NOT NULL DEFAULT 0"],
  ["cached_product_profit_total", "real NOT NULL DEFAULT 0"],
  ["reconciliation_status", "text NOT NULL DEFAULT 'fail'"],
  ["formula_count", "integer NOT NULL DEFAULT 0"],
  ["formula_error_count", "integer NOT NULL DEFAULT 0"],
  ["fixed_range_risk_count", "integer NOT NULL DEFAULT 0"],
  ["registered_product_count", "integer NOT NULL DEFAULT 0"],
  ["created_by", "text REFERENCES auth_users(id) ON DELETE SET NULL"],
  ["stage", "text NOT NULL DEFAULT '等待解析'"],
  ["progress", "integer NOT NULL DEFAULT 0"],
  ["source_order_rows", "integer NOT NULL DEFAULT 0"],
  ["source_order_last_row", "integer NOT NULL DEFAULT 0"],
  ["source_spend_rows", "integer NOT NULL DEFAULT 0"],
  ["source_spend_last_row", "integer NOT NULL DEFAULT 0"],
  ["product_period_start", "text"],
  ["product_period_end", "text"],
  ["snapshot_date", "text"],
  ["maturity_days", "integer NOT NULL DEFAULT 6"],
  ["previewed_at", "integer"],
  ["committed_at", "integer"],
] as const) {
  if (!analyticsImportColumnNames.has(name)) safeRun(`ALTER TABLE analytics_imports ADD COLUMN ${name} ${definition}`);
}

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_store_daily (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    metric_date text NOT NULL,
    store_name text NOT NULL,
    business_owner text,
    gmv real NOT NULL DEFAULT 0,
    product_cost real NOT NULL DEFAULT 0,
    pre_ship_refund_amount real NOT NULL DEFAULT 0,
    total_refund_amount real NOT NULL DEFAULT 0,
    post_ship_refund_amount real NOT NULL DEFAULT 0,
    post_ship_refund_orders real NOT NULL DEFAULT 0,
    return_shipping_cost real NOT NULL DEFAULT 0,
    service_fee real NOT NULL DEFAULT 0,
    one_hour_refund_amount real NOT NULL DEFAULT 0,
    compensation_registered real NOT NULL DEFAULT 0,
    compensation_spend real NOT NULL DEFAULT 0,
    ad_spend real NOT NULL DEFAULT 0,
    actual_profit real NOT NULL DEFAULT 0,
    compensation_profit real NOT NULL DEFAULT 0,
    fake_orders real NOT NULL DEFAULT 0,
    paid_orders real NOT NULL DEFAULT 0,
    profit_margin real NOT NULL DEFAULT 0,
    compensation_roi real NOT NULL DEFAULT 0,
    overall_refund_rate real NOT NULL DEFAULT 0,
    one_hour_refund_rate real NOT NULL DEFAULT 0,
    pre_ship_refund_rate real NOT NULL DEFAULT 0,
    post_ship_refund_rate real NOT NULL DEFAULT 0,
    gmv_gap real NOT NULL DEFAULT 0
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_product_metrics (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    store_product_key text NOT NULL,
    metric_date text,
    is_summary integer NOT NULL DEFAULT 0,
    business_owner text,
    store_name text NOT NULL,
    product_id text NOT NULL,
    plan_id text,
    product_name text NOT NULL,
    category_name text NOT NULL DEFAULT '未登记类目',
    submitted_orders real NOT NULL DEFAULT 0,
    one_hour_refund_orders real NOT NULL DEFAULT 0,
    paid_orders real NOT NULL DEFAULT 0,
    pre_ship_refund_orders real NOT NULL DEFAULT 0,
    shipped_orders real NOT NULL DEFAULT 0,
    pending_orders real NOT NULL DEFAULT 0,
    post_ship_refund_orders real NOT NULL DEFAULT 0,
    fake_orders real NOT NULL DEFAULT 0,
    price real,
    cost real,
    non_fake_orders real NOT NULL DEFAULT 0,
    gmv real NOT NULL DEFAULT 0,
    ad_spend real NOT NULL DEFAULT 0,
    compensation real NOT NULL DEFAULT 0,
    roi real NOT NULL DEFAULT 0,
    compensation_roi real NOT NULL DEFAULT 0,
    profit_margin real NOT NULL DEFAULT 0,
    net_deal_roi real NOT NULL DEFAULT 0,
    actual_profit real NOT NULL DEFAULT 0,
    profit_available integer NOT NULL DEFAULT 1,
    one_hour_refund_rate real NOT NULL DEFAULT 0,
    net_shipping_rate real NOT NULL DEFAULT 0,
    overall_shipping_rate real NOT NULL DEFAULT 0,
    sign_rate real NOT NULL DEFAULT 0
  )
`);

const analyticsProductColumns = sqlite.prepare("PRAGMA table_info(analytics_product_metrics)").all() as Array<{ name: string }>;
const analyticsProductColumnNames = new Set(analyticsProductColumns.map((column) => column.name));
for (const [name, definition] of [
  ["plan_id", "text"],
  ["category_name", "text NOT NULL DEFAULT '未登记类目'"],
  ["pending_orders", "real NOT NULL DEFAULT 0"],
  ["profit_available", "integer NOT NULL DEFAULT 1"],
] as const) {
  if (!analyticsProductColumnNames.has(name)) safeRun(`ALTER TABLE analytics_product_metrics ADD COLUMN ${name} ${definition}`);
}

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_product_registry (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    store_name text NOT NULL,
    product_id text NOT NULL,
    product_name text NOT NULL,
    category_name text NOT NULL DEFAULT '未登记类目',
    plan_id text,
    created_at integer
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_plan_daily (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    metric_date text NOT NULL,
    build_date text,
    plan_id text NOT NULL,
    plan_name text NOT NULL,
    account_id text NOT NULL,
    account_short_name text NOT NULL DEFAULT '',
    account_name text NOT NULL DEFAULT '',
    store_name text NOT NULL DEFAULT '',
    product_id text NOT NULL,
    product_name text NOT NULL,
    price real,
    target_roi real NOT NULL DEFAULT 0,
    spend real NOT NULL DEFAULT 0,
    net_orders real NOT NULL DEFAULT 0,
    net_amount real NOT NULL DEFAULT 0,
    net_roi real NOT NULL DEFAULT 0,
    compensation real NOT NULL DEFAULT 0,
    latest_status text NOT NULL DEFAULT '',
    effective_orders real NOT NULL DEFAULT 0,
    brush_like integer NOT NULL DEFAULT 0,
    roi_hit integer NOT NULL DEFAULT 0,
    low_order_stop integer NOT NULL DEFAULT 0
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_data_issues (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    severity text NOT NULL DEFAULT 'warning',
    issue_type text NOT NULL,
    scope text NOT NULL,
    entity_key text,
    message text NOT NULL
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_sheet_audits (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    sheet_name text NOT NULL,
    sheet_role text NOT NULL,
    business_purpose text NOT NULL,
    join_keys text NOT NULL,
    row_count integer NOT NULL,
    data_row_count integer NOT NULL DEFAULT 0,
    last_data_row integer NOT NULL DEFAULT 0,
    column_count integer NOT NULL,
    formula_count integer NOT NULL,
    formula_pattern_count integer NOT NULL,
    formula_error_count integer NOT NULL,
    fixed_range_reference_count integer NOT NULL DEFAULT 0,
    fixed_range_risk_count integer NOT NULL,
    reference_limit_row integer,
    reference_usage real,
    hidden_row_count integer NOT NULL,
    hidden_sheet integer NOT NULL DEFAULT 0,
    auto_filter text,
    headers text NOT NULL,
    dependencies text NOT NULL,
    status text NOT NULL,
    risk_messages text NOT NULL
  )
`);

const analyticsSheetAuditColumns = sqlite.prepare("PRAGMA table_info(analytics_sheet_audits)").all() as Array<{ name: string }>;
const analyticsSheetAuditColumnNames = new Set(analyticsSheetAuditColumns.map((column) => column.name));
for (const [name, definition] of [
  ["data_row_count", "integer NOT NULL DEFAULT 0"],
  ["last_data_row", "integer NOT NULL DEFAULT 0"],
  ["fixed_range_reference_count", "integer NOT NULL DEFAULT 0"],
  ["reference_limit_row", "integer"],
  ["reference_usage", "real"],
] as const) {
  if (!analyticsSheetAuditColumnNames.has(name)) safeRun(`ALTER TABLE analytics_sheet_audits ADD COLUMN ${name} ${definition}`);
}

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_formula_audits (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    sheet_name text NOT NULL,
    column_ref text NOT NULL,
    column_header text,
    formula_pattern text NOT NULL,
    sample_cell text NOT NULL,
    sample_formula text NOT NULL,
    formula_count integer NOT NULL,
    first_row integer NOT NULL,
    last_row integer NOT NULL,
    dependencies text NOT NULL,
    formula_kind text NOT NULL,
    business_meaning text NOT NULL,
    has_fixed_range_reference integer NOT NULL DEFAULT 0,
    has_fixed_range_risk integer NOT NULL DEFAULT 0,
    has_formula_error integer NOT NULL DEFAULT 0
  )
`);

const analyticsFormulaAuditColumns = sqlite.prepare("PRAGMA table_info(analytics_formula_audits)").all() as Array<{ name: string }>;
const analyticsFormulaAuditColumnNames = new Set(analyticsFormulaAuditColumns.map((column) => column.name));
if (!analyticsFormulaAuditColumnNames.has("has_fixed_range_reference")) {
  safeRun("ALTER TABLE analytics_formula_audits ADD COLUMN has_fixed_range_reference integer NOT NULL DEFAULT 0");
}

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_reconciliations (
    id text PRIMARY KEY,
    import_id text NOT NULL REFERENCES analytics_imports(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    check_key text NOT NULL,
    category text NOT NULL,
    status text NOT NULL,
    label text NOT NULL,
    expected_value real,
    actual_value real,
    difference real,
    tolerance real,
    message text NOT NULL
  )
`);

safeRun(`
  CREATE TABLE IF NOT EXISTS analytics_audit_logs (
    id text PRIMARY KEY,
    actor_id text REFERENCES auth_users(id) ON DELETE SET NULL,
    owner_id text REFERENCES auth_users(id) ON DELETE SET NULL,
    import_id text REFERENCES analytics_imports(id) ON DELETE SET NULL,
    action text NOT NULL,
    detail text NOT NULL,
    created_at integer
  )
`);

safeRun("CREATE INDEX IF NOT EXISTS analytics_imports_owner_created_idx ON analytics_imports(owner_id, created_at DESC)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_store_owner_import_date_idx ON analytics_store_daily(owner_id, import_id, metric_date)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_product_owner_import_date_idx ON analytics_product_metrics(owner_id, import_id, metric_date)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_product_key_idx ON analytics_product_metrics(import_id, store_product_key, is_summary)");
safeRun("CREATE UNIQUE INDEX IF NOT EXISTS analytics_product_registry_unique_idx ON analytics_product_registry(import_id, owner_id, store_name, product_id)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_product_registry_owner_import_idx ON analytics_product_registry(owner_id, import_id, store_name)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_plan_owner_import_date_idx ON analytics_plan_daily(owner_id, import_id, metric_date)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_plan_product_account_idx ON analytics_plan_daily(import_id, product_name, account_id, metric_date)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_plan_id_date_idx ON analytics_plan_daily(import_id, plan_id, metric_date)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_issues_import_idx ON analytics_data_issues(import_id, severity)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_sheet_audits_import_idx ON analytics_sheet_audits(import_id, sheet_name)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_formula_audits_import_idx ON analytics_formula_audits(import_id, sheet_name, column_ref)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_reconciliations_import_idx ON analytics_reconciliations(import_id, status)");
safeRun("CREATE INDEX IF NOT EXISTS analytics_audit_logs_created_idx ON analytics_audit_logs(created_at DESC)");

const adminExists = sqlite
  .prepare("SELECT id FROM auth_users WHERE id = ? OR username = ? LIMIT 1")
  .get(ADMIN_USER_ID, ADMIN_USERNAME);
if (!adminExists) {
  if (!ADMIN_PASSWORD) {
    throw new Error("首次初始化需要设置 LUMA_ADMIN_PASSWORD，拒绝使用内置默认管理员密码。");
  }
  const nowForAdmin = Date.now();
  sqlite.prepare(`
    INSERT INTO auth_users (
      id, account_id, username, password_hash, role, disabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'admin', 0, ?, ?)
  `).run(ADMIN_USER_ID, ADMIN_ACCOUNT_ID, ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD), nowForAdmin, nowForAdmin);
}

const hasProjectsTable = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
  .get();
if (hasProjectsTable) {
  const projectColumns = sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  const projectColumnNames = new Set(projectColumns.map((column) => column.name));
  if (!projectColumnNames.has("current_version_id")) {
    safeRun("ALTER TABLE projects ADD COLUMN current_version_id text");
  }
  if (!projectColumnNames.has("owner_id")) {
    safeRun(`ALTER TABLE projects ADD COLUMN owner_id text NOT NULL DEFAULT '${ADMIN_USER_ID}'`);
  }
  if (!projectColumnNames.has("video_aspect_ratio")) {
    safeRun("ALTER TABLE projects ADD COLUMN video_aspect_ratio text DEFAULT '9:16'");
  }
  if (!projectColumnNames.has("video_resolution")) {
    safeRun("ALTER TABLE projects ADD COLUMN video_resolution text DEFAULT '720p'");
  }
  if (!projectColumnNames.has("image_channel_id")) {
    safeRun("ALTER TABLE projects ADD COLUMN image_channel_id text");
  }
  if (!projectColumnNames.has("video_channel_id")) {
    safeRun("ALTER TABLE projects ADD COLUMN video_channel_id text");
  }
}

for (const table of ["products", "brand_settings", "script_templates", "characters"]) {
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!tableExists) continue;
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("owner_id")) {
    safeRun(`ALTER TABLE ${table} ADD COLUMN owner_id text NOT NULL DEFAULT '${ADMIN_USER_ID}'`);
  }
}

if (hasProjectsTable) {
safeRun(`
  CREATE TABLE IF NOT EXISTS project_versions (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    version_number integer NOT NULL DEFAULT 1,
    version_type text NOT NULL DEFAULT 'normal',
    status text NOT NULL DEFAULT 'draft',
    product_analysis text,
    config_snapshot text,
    is_default integer DEFAULT 0,
    created_at integer,
    updated_at integer
  )
`);

const versionedTables = ["scripts", "assets", "video_clips", "compositions"].filter((table) => Boolean(
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
));

for (const table of versionedTables) {
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!tableExists) continue;
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("version_id")) {
    safeRun(`ALTER TABLE ${table} ADD COLUMN version_id text`);
  }
}

const projectRows = sqlite.prepare(`
      SELECT id, status, source_type, product_analysis, current_version_id
      FROM projects
    `).all() as Array<{
  id: string;
  status: string | null;
  source_type: string | null;
  product_analysis: string | null;
  current_version_id: string | null;
}>;

const now = Date.now();
const insertDefaultVersion = sqlite.prepare(`
  INSERT INTO project_versions (
    id, project_id, name, version_number, version_type, status,
    product_analysis, config_snapshot, is_default, created_at, updated_at
  ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, 1, ?, ?)
`);
const selectDefaultVersion = sqlite.prepare(`
  SELECT id FROM project_versions
  WHERE project_id = ? AND is_default = 1
  ORDER BY version_number ASC, created_at ASC
  LIMIT 1
`);
const updateProjectCurrentVersion = sqlite.prepare(`
  UPDATE projects SET current_version_id = ? WHERE id = ?
`);
const assignTableVersion = (table: string) => sqlite.prepare(`
  UPDATE ${table}
  SET version_id = ?
  WHERE project_id = ? AND (version_id IS NULL OR version_id = '')
`);

for (const project of projectRows) {
  let version = selectDefaultVersion.get(project.id) as { id: string } | undefined;
  if (!version) {
    const versionId = crypto.randomUUID();
    insertDefaultVersion.run(
      versionId,
      project.id,
      "版本1",
      project.source_type === "clone" ? "clone" : "normal",
      project.status || "draft",
      project.product_analysis || null,
      now,
      now
    );
    version = { id: versionId };
  }

  if (!project.current_version_id) {
    updateProjectCurrentVersion.run(version.id, project.id);
  }

  for (const table of versionedTables) {
    assignTableVersion(table).run(version.id, project.id);
  }
}
}

export const db = drizzle(sqlite, { schema });

export function getDb() {
  return db;
}
