import { AnySQLiteColumn, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().default("luma-admin"),
  name: text("name").notNull(),
  status: text("status", { enum: ["draft", "scripting", "assets", "video", "composing", "done"] }).notNull().default("draft"),
  currentVersionId: text("current_version_id"),
  productName: text("product_name"),
  productCategory: text("product_category"),
  productDescription: text("product_description"),
  productImages: text("product_images", { mode: "json" }).$type<string[]>().default([]),
  productAnalysis: text("product_analysis"),
  productId: text("product_id"),
  brandId: text("brand_id"),
  templateId: text("template_id"),
  videoMode: text("video_mode", { enum: ["product_closeup", "graphic_montage", "scene_demo", "live_presenter"] }).default("product_closeup"),
  sourceType: text("source_type", { enum: ["manual", "clone"] }).default("manual"),
  sourceVideoUrl: text("source_video_url"),
  characterId: text("character_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  videoAspectRatio: text("video_aspect_ratio", { enum: ["9:16", "16:9", "1:1"] }).default("9:16"),
  videoResolution: text("video_resolution", { enum: ["720p", "1080p"] }).default("720p"),
  imageChannelId: text("image_channel_id"),
  videoChannelId: text("video_channel_id"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const projectVersions = sqliteTable("project_versions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  versionNumber: integer("version_number").notNull().default(1),
  versionType: text("version_type", { enum: ["normal", "clone"] }).notNull().default("normal"),
  status: text("status", { enum: ["draft", "scripting", "assets", "video", "composing", "done"] }).notNull().default("draft"),
  productAnalysis: text("product_analysis"),
  configSnapshot: text("config_snapshot", { mode: "json" }).$type<Record<string, unknown>>(),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const scripts = sqliteTable("scripts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  versionId: text("version_id").references(() => projectVersions.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  styleType: text("style_type", { enum: ["pain_point", "scene", "comparison", "story", "custom"] }).notNull(),
  title: text("title"),
  totalDuration: integer("total_duration"),
  shots: text("shots", { mode: "json" }).$type<Shot[]>().default([]),
  selected: integer("selected", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  versionId: text("version_id").references(() => projectVersions.id, { onDelete: "cascade" }),
  shotId: integer("shot_id").notNull(),
  type: text("type", { enum: ["ai_generated", "product_image", "user_upload"] }).notNull(),
  filePath: text("file_path"),
  thumbnailPath: text("thumbnail_path"),
  provider: text("provider"),
  model: text("model"),
  prompt: text("prompt"),
  status: text("status", { enum: ["pending", "generating", "done", "failed"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const videoClips = sqliteTable("video_clips", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  versionId: text("version_id").references(() => projectVersions.id, { onDelete: "cascade" }),
  shotId: integer("shot_id").notNull(),
  assetId: text("asset_id").references(() => assets.id),
  filePath: text("file_path"),
  duration: integer("duration"),
  provider: text("provider"),
  model: text("model"),
  transitionType: text("transition_type", { enum: ["ai_start_end", "ai_reference", "direct_concat", "ffmpeg_fade"] }).default("ai_start_end"),
  status: text("status", { enum: ["pending", "generating", "done", "failed"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const compositions = sqliteTable("compositions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  versionId: text("version_id").references(() => projectVersions.id, { onDelete: "cascade" }),
  outputPath: text("output_path"),
  resolution: text("resolution", { enum: ["720p", "1080p"] }).default("1080p"),
  aspectRatio: text("aspect_ratio", { enum: ["9:16", "16:9", "1:1"] }).default("9:16"),
  duration: integer("duration"),
  bgmPath: text("bgm_path"),
  ttsEnabled: integer("tts_enabled", { mode: "boolean" }).default(false),
  subtitleStyle: text("subtitle_style", { mode: "json" }).$type<SubtitleStyle>(),
  status: text("status", { enum: ["pending", "composing", "done", "failed"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().default("luma-admin"),
  name: text("name").notNull(),
  category: text("category", { enum: ["beauty", "food", "home", "fashion", "tech", "other"] }).notNull(),
  description: text("description"),
  images: text("images", { mode: "json" }).$type<string[]>().default([]),
  price: text("price"),
  targetAudience: text("target_audience"),
  analysis: text("analysis"),
  usageScenarios: text("usage_scenarios"),
  negativeConstraints: text("negative_constraints"),
  videoCount: integer("video_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const brandSettings = sqliteTable("brand_settings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().default("luma-admin"),
  name: text("name").notNull(),
  logoPath: text("logo_path"),
  primaryColor: text("primary_color"),
  secondaryColor: text("secondary_color"),
  fontFamily: text("font_family"),
  watermark: text("watermark", { mode: "json" }).$type<WatermarkConfig>(),
  introTemplatePath: text("intro_template_path"),
  outroTemplatePath: text("outro_template_path"),
  isDefault: integer("is_default", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const scriptTemplates = sqliteTable("script_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().default("luma-admin"),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  videoMode: text("video_mode"),
  styleType: text("style_type"),
  shots: text("shots", { mode: "json" }).$type<Shot[]>().default([]),
  sourceProjectId: text("source_project_id"),
  useCount: integer("use_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().default("luma-admin"),
  name: text("name").notNull(),
  description: text("description"),
  appearance: text("appearance"),
  referenceImages: text("reference_images", { mode: "json" }).$type<string[]>().default([]),
  voiceProfile: text("voice_profile", { mode: "json" }).$type<CharacterVoiceProfile>(),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const authUsers = sqliteTable("auth_users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  accountId: text("account_id").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const authInvites = sqliteTable("auth_invites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  codeHash: text("code_hash").notNull().unique(),
  label: text("label"),
  createdByUserId: text("created_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
  usedByUserId: text("used_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const userModelSettings = sqliteTable("user_model_settings", {
  userId: text("user_id").primaryKey().references(() => authUsers.id, { onDelete: "cascade" }),
  settings: text("settings", { mode: "json" }).$type<{
    providers: Record<string, unknown>;
    llm: Record<string, unknown>;
  }>().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const modelChannels = sqliteTable("model_channels", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["llm", "image", "video"] }).notNull(),
  providerKey: text("provider_key").notNull(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  baseUrl: text("base_url").notNull().default(""),
  model: text("model").notNull().default(""),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const userModelCredentials = sqliteTable("user_model_credentials", {
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => modelChannels.id, { onDelete: "cascade" }),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.userId, table.channelId] }),
]);

export const userVideoReferenceHostingCredentials = sqliteTable("user_video_reference_hosting_credentials", {
  userId: text("user_id").primaryKey().references(() => authUsers.id, { onDelete: "cascade" }),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  encryptedApiSecret: text("encrypted_api_secret").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const userFeatureEntries = sqliteTable("user_feature_entries", {
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  featureKey: text("feature_key").notNull(),
  entryState: text("entry_state", { enum: ["open", "waiting"] }).notNull().default("open"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.userId, table.featureKey] }),
]);

export const modelApiCalls = sqliteTable("model_api_calls", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  callType: text("call_type", { enum: ["llm", "image", "video"] }).notNull(),
  providerKey: text("provider_key").notNull(),
  channelId: text("channel_id").references(() => modelChannels.id, { onDelete: "set null" }),
  channelName: text("channel_name"),
  model: text("model"),
  source: text("source").notNull(),
  projectId: text("project_id"),
  boardWorkflowId: text("board_workflow_id"),
  boardNodeId: text("board_node_id"),
  quickCutTaskId: text("quick_cut_task_id"),
  productProductionTaskId: text("product_production_task_id"),
  productProductionJobId: text("product_production_job_id"),
  parentCallId: text("parent_call_id").references((): AnySQLiteColumn => modelApiCalls.id, { onDelete: "set null" }),
  attemptNumber: integer("attempt_number").notNull().default(1),
  status: text("status", { enum: ["success", "error"] }).notNull(),
  httpStatus: integer("http_status"),
  remoteTaskId: text("remote_task_id"),
  durationMs: integer("duration_ms").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  usageJson: text("usage_json", { mode: "json" }).$type<Record<string, number>>(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export const productProductionTasks = sqliteTable("product_production_tasks", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  name: text("name").notNull(),
  status: text("status", { enum: ["draft", "ready", "queued", "running", "partial", "done", "failed", "cancelled"] }).notNull().default("draft"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export const quickCutTasks = sqliteTable("quick_cut_tasks", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["draft", "scanning", "ready", "analyzing", "rendering", "processing", "completed", "partial", "failed", "stopped"] }).notNull().default("draft"),
  sourceRoot: text("source_root").notNull(),
  taskRoot: text("task_root").notNull(),
  stage: text("stage").notNull().default("等待素材"),
  settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  scan: text("scan", { mode: "json" }).$type<Record<string, unknown> | null>(),
  analysisSummary: text("analysis_summary", { mode: "json" }).$type<Record<string, unknown> | null>(),
  plans: text("plans", { mode: "json" }).$type<unknown[] | null>(),
  rows: text("rows", { mode: "json" }).$type<unknown[]>().notNull().default([]),
  events: text("events", { mode: "json" }).$type<Record<string, unknown>[]>().notNull().default([]),
  progress: integer("progress").notNull().default(0),
  total: integer("total").notNull().default(0),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export const analyticsImports = sqliteTable("analytics_imports", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  status: text("status", { enum: ["queued", "processing", "preview_ready", "completed", "failed"] }).notNull().default("queued"),
  createdBy: text("created_by").references(() => authUsers.id, { onDelete: "set null" }),
  stage: text("stage").notNull().default("等待解析"),
  progress: integer("progress").notNull().default(0),
  periodStart: text("period_start"),
  periodEnd: text("period_end"),
  productPeriodStart: text("product_period_start"),
  productPeriodEnd: text("product_period_end"),
  storeCount: integer("store_count").notNull().default(0),
  productCount: integer("product_count").notNull().default(0),
  registeredProductCount: integer("registered_product_count").notNull().default(0),
  storeRowCount: integer("store_row_count").notNull().default(0),
  productRowCount: integer("product_row_count").notNull().default(0),
  productProfitTotal: real("product_profit_total").notNull().default(0),
  cachedProductProfitTotal: real("cached_product_profit_total").notNull().default(0),
  reconciliationStatus: text("reconciliation_status", { enum: ["pass", "warning", "fail"] }).notNull().default("fail"),
  formulaCount: integer("formula_count").notNull().default(0),
  formulaErrorCount: integer("formula_error_count").notNull().default(0),
  fixedRangeRiskCount: integer("fixed_range_risk_count").notNull().default(0),
  issueCount: integer("issue_count").notNull().default(0),
  sourceOrderRows: integer("source_order_rows").notNull().default(0),
  sourceOrderLastRow: integer("source_order_last_row").notNull().default(0),
  sourceSpendRows: integer("source_spend_rows").notNull().default(0),
  sourceSpendLastRow: integer("source_spend_last_row").notNull().default(0),
  snapshotDate: text("snapshot_date"),
  maturityDays: integer("maturity_days").notNull().default(6),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  previewedAt: integer("previewed_at", { mode: "timestamp" }),
  committedAt: integer("committed_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export const analyticsStoreDaily = sqliteTable("analytics_store_daily", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  metricDate: text("metric_date").notNull(),
  storeName: text("store_name").notNull(),
  businessOwner: text("business_owner"),
  gmv: real("gmv").notNull().default(0),
  productCost: real("product_cost").notNull().default(0),
  preShipRefundAmount: real("pre_ship_refund_amount").notNull().default(0),
  totalRefundAmount: real("total_refund_amount").notNull().default(0),
  postShipRefundAmount: real("post_ship_refund_amount").notNull().default(0),
  postShipRefundOrders: real("post_ship_refund_orders").notNull().default(0),
  returnShippingCost: real("return_shipping_cost").notNull().default(0),
  serviceFee: real("service_fee").notNull().default(0),
  oneHourRefundAmount: real("one_hour_refund_amount").notNull().default(0),
  compensationRegistered: real("compensation_registered").notNull().default(0),
  compensationSpend: real("compensation_spend").notNull().default(0),
  adSpend: real("ad_spend").notNull().default(0),
  actualProfit: real("actual_profit").notNull().default(0),
  compensationProfit: real("compensation_profit").notNull().default(0),
  fakeOrders: real("fake_orders").notNull().default(0),
  paidOrders: real("paid_orders").notNull().default(0),
  profitMargin: real("profit_margin").notNull().default(0),
  compensationRoi: real("compensation_roi").notNull().default(0),
  overallRefundRate: real("overall_refund_rate").notNull().default(0),
  oneHourRefundRate: real("one_hour_refund_rate").notNull().default(0),
  preShipRefundRate: real("pre_ship_refund_rate").notNull().default(0),
  postShipRefundRate: real("post_ship_refund_rate").notNull().default(0),
  gmvGap: real("gmv_gap").notNull().default(0),
});

export const analyticsProductMetrics = sqliteTable("analytics_product_metrics", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  storeProductKey: text("store_product_key").notNull(),
  metricDate: text("metric_date"),
  isSummary: integer("is_summary", { mode: "boolean" }).notNull().default(false),
  businessOwner: text("business_owner"),
  storeName: text("store_name").notNull(),
  productId: text("product_id").notNull(),
  planId: text("plan_id"),
  productName: text("product_name").notNull(),
  categoryName: text("category_name").notNull().default("未登记类目"),
  submittedOrders: real("submitted_orders").notNull().default(0),
  oneHourRefundOrders: real("one_hour_refund_orders").notNull().default(0),
  paidOrders: real("paid_orders").notNull().default(0),
  preShipRefundOrders: real("pre_ship_refund_orders").notNull().default(0),
  shippedOrders: real("shipped_orders").notNull().default(0),
  pendingOrders: real("pending_orders").notNull().default(0),
  postShipRefundOrders: real("post_ship_refund_orders").notNull().default(0),
  fakeOrders: real("fake_orders").notNull().default(0),
  price: real("price"),
  cost: real("cost"),
  nonFakeOrders: real("non_fake_orders").notNull().default(0),
  gmv: real("gmv").notNull().default(0),
  adSpend: real("ad_spend").notNull().default(0),
  compensation: real("compensation").notNull().default(0),
  roi: real("roi").notNull().default(0),
  compensationRoi: real("compensation_roi").notNull().default(0),
  profitMargin: real("profit_margin").notNull().default(0),
  netDealRoi: real("net_deal_roi").notNull().default(0),
  actualProfit: real("actual_profit").notNull().default(0),
  profitAvailable: integer("profit_available", { mode: "boolean" }).notNull().default(true),
  oneHourRefundRate: real("one_hour_refund_rate").notNull().default(0),
  netShippingRate: real("net_shipping_rate").notNull().default(0),
  overallShippingRate: real("overall_shipping_rate").notNull().default(0),
  signRate: real("sign_rate").notNull().default(0),
});

export const analyticsProductRegistry = sqliteTable("analytics_product_registry", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  storeName: text("store_name").notNull(),
  productId: text("product_id").notNull(),
  productName: text("product_name").notNull(),
  categoryName: text("category_name").notNull().default("未登记类目"),
  planId: text("plan_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const analyticsPlanDaily = sqliteTable("analytics_plan_daily", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  metricDate: text("metric_date").notNull(),
  buildDate: text("build_date"),
  planId: text("plan_id").notNull(),
  planName: text("plan_name").notNull(),
  accountId: text("account_id").notNull(),
  accountShortName: text("account_short_name").notNull().default(""),
  accountName: text("account_name").notNull().default(""),
  storeName: text("store_name").notNull().default(""),
  productId: text("product_id").notNull(),
  productName: text("product_name").notNull(),
  price: real("price"),
  targetRoi: real("target_roi").notNull().default(0),
  spend: real("spend").notNull().default(0),
  netOrders: real("net_orders").notNull().default(0),
  netAmount: real("net_amount").notNull().default(0),
  netRoi: real("net_roi").notNull().default(0),
  compensation: real("compensation").notNull().default(0),
  latestStatus: text("latest_status").notNull().default(""),
  effectiveOrders: real("effective_orders").notNull().default(0),
  brushLike: integer("brush_like").notNull().default(0),
  roiHit: integer("roi_hit").notNull().default(0),
  lowOrderStop: integer("low_order_stop").notNull().default(0),
});

export const analyticsDataIssues = sqliteTable("analytics_data_issues", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull().default("warning"),
  issueType: text("issue_type").notNull(),
  scope: text("scope", { enum: ["import", "store", "product"] }).notNull(),
  entityKey: text("entity_key"),
  message: text("message").notNull(),
});

export const analyticsSheetAudits = sqliteTable("analytics_sheet_audits", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  sheetName: text("sheet_name").notNull(),
  sheetRole: text("sheet_role", { enum: ["source", "lookup", "transform", "decision", "documentation"] }).notNull(),
  businessPurpose: text("business_purpose").notNull(),
  joinKeys: text("join_keys", { mode: "json" }).$type<string[]>().notNull(),
  rowCount: integer("row_count").notNull(),
  dataRowCount: integer("data_row_count").notNull().default(0),
  lastDataRow: integer("last_data_row").notNull().default(0),
  columnCount: integer("column_count").notNull(),
  formulaCount: integer("formula_count").notNull(),
  formulaPatternCount: integer("formula_pattern_count").notNull(),
  formulaErrorCount: integer("formula_error_count").notNull(),
  fixedRangeReferenceCount: integer("fixed_range_reference_count").notNull().default(0),
  fixedRangeRiskCount: integer("fixed_range_risk_count").notNull(),
  referenceLimitRow: integer("reference_limit_row"),
  referenceUsage: real("reference_usage"),
  hiddenRowCount: integer("hidden_row_count").notNull(),
  hiddenSheet: integer("hidden_sheet", { mode: "boolean" }).notNull().default(false),
  autoFilter: text("auto_filter"),
  headers: text("headers", { mode: "json" }).$type<string[]>().notNull(),
  dependencies: text("dependencies", { mode: "json" }).$type<string[]>().notNull(),
  status: text("status", { enum: ["pass", "warning", "fail"] }).notNull(),
  riskMessages: text("risk_messages", { mode: "json" }).$type<string[]>().notNull(),
});

export const analyticsFormulaAudits = sqliteTable("analytics_formula_audits", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  sheetName: text("sheet_name").notNull(),
  columnRef: text("column_ref").notNull(),
  columnHeader: text("column_header"),
  formulaPattern: text("formula_pattern").notNull(),
  sampleCell: text("sample_cell").notNull(),
  sampleFormula: text("sample_formula").notNull(),
  formulaCount: integer("formula_count").notNull(),
  firstRow: integer("first_row").notNull(),
  lastRow: integer("last_row").notNull(),
  dependencies: text("dependencies", { mode: "json" }).$type<string[]>().notNull(),
  formulaKind: text("formula_kind", { enum: ["mapping", "aggregation", "transformation", "calculation", "simulation"] }).notNull(),
  businessMeaning: text("business_meaning").notNull(),
  hasFixedRangeReference: integer("has_fixed_range_reference", { mode: "boolean" }).notNull().default(false),
  hasFixedRangeRisk: integer("has_fixed_range_risk", { mode: "boolean" }).notNull().default(false),
  hasFormulaError: integer("has_formula_error", { mode: "boolean" }).notNull().default(false),
});

export const analyticsReconciliations = sqliteTable("analytics_reconciliations", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => analyticsImports.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  checkKey: text("check_key").notNull(),
  category: text("category", { enum: ["structure", "formula", "store", "product", "mapping"] }).notNull(),
  status: text("status", { enum: ["pass", "warning", "fail"] }).notNull(),
  label: text("label").notNull(),
  expectedValue: real("expected_value"),
  actualValue: real("actual_value"),
  difference: real("difference"),
  tolerance: real("tolerance"),
  message: text("message").notNull(),
});

export const analyticsAuditLogs = sqliteTable("analytics_audit_logs", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").references(() => authUsers.id, { onDelete: "set null" }),
  ownerId: text("owner_id").references(() => authUsers.id, { onDelete: "set null" }),
  importId: text("import_id").references(() => analyticsImports.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export type ProjectVersionType = "normal" | "clone";

export type VideoMode =
  | "product_closeup"
  | "graphic_montage"
  | "scene_demo"
  | "live_presenter";

export interface Shot {
  shotId: number;
  type: "hook" | "pain_point" | "product_reveal" | "demo" | "social_proof" | "cta";
  duration: number;
  description: string;
  camera: string;
  visualSource: "ai_generate" | "product_image" | "user_upload";
  transition: "ai_start_end" | "ai_reference" | "direct_concat" | "ffmpeg_fade";
  voiceover: string;
  prompt?: string;
  characterId?: string;
  motion?: "zoom_in_slow" | "pan_left" | "pan_right" | "ken_burns" | "static";
  textOverlay?: {
    text: string;
    style: "title" | "subtitle" | "highlight" | "price";
  };
}

export interface CharacterVoiceProfile {
  style: string;
  speed?: number;
  emotion?: "neutral" | "happy" | "serious" | "energetic";
}

export interface WatermarkConfig {
  enabled: boolean;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  opacity: number;
  scale: number;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  position: "bottom" | "center" | "top";
}
