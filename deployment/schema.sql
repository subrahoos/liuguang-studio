CREATE TABLE `analytics_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`owner_id` text,
	`import_id` text,
	`action` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`actor_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE set null
);

CREATE TABLE `analytics_data_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`issue_type` text NOT NULL,
	`scope` text NOT NULL,
	`entity_key` text,
	`message` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `analytics_formula_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`sheet_name` text NOT NULL,
	`column_ref` text NOT NULL,
	`column_header` text,
	`formula_pattern` text NOT NULL,
	`sample_cell` text NOT NULL,
	`sample_formula` text NOT NULL,
	`formula_count` integer NOT NULL,
	`first_row` integer NOT NULL,
	`last_row` integer NOT NULL,
	`dependencies` text NOT NULL,
	`formula_kind` text NOT NULL,
	`business_meaning` text NOT NULL,
	`has_fixed_range_reference` integer DEFAULT false NOT NULL,
	`has_fixed_range_risk` integer DEFAULT false NOT NULL,
	`has_formula_error` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `analytics_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_path` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_by` text,
	`stage` text DEFAULT '等待解析' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`period_start` text,
	`period_end` text,
	`product_period_start` text,
	`product_period_end` text,
	`store_count` integer DEFAULT 0 NOT NULL,
	`product_count` integer DEFAULT 0 NOT NULL,
	`registered_product_count` integer DEFAULT 0 NOT NULL,
	`store_row_count` integer DEFAULT 0 NOT NULL,
	`product_row_count` integer DEFAULT 0 NOT NULL,
	`product_profit_total` real DEFAULT 0 NOT NULL,
	`cached_product_profit_total` real DEFAULT 0 NOT NULL,
	`reconciliation_status` text DEFAULT 'fail' NOT NULL,
	`formula_count` integer DEFAULT 0 NOT NULL,
	`formula_error_count` integer DEFAULT 0 NOT NULL,
	`fixed_range_risk_count` integer DEFAULT 0 NOT NULL,
	`issue_count` integer DEFAULT 0 NOT NULL,
	`source_order_rows` integer DEFAULT 0 NOT NULL,
	`source_order_last_row` integer DEFAULT 0 NOT NULL,
	`source_spend_rows` integer DEFAULT 0 NOT NULL,
	`source_spend_last_row` integer DEFAULT 0 NOT NULL,
	`snapshot_date` text,
	`maturity_days` integer DEFAULT 6 NOT NULL,
	`error_message` text,
	`created_at` integer,
	`previewed_at` integer,
	`committed_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null
);

CREATE TABLE `analytics_plan_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`metric_date` text NOT NULL,
	`build_date` text,
	`plan_id` text NOT NULL,
	`plan_name` text NOT NULL,
	`account_id` text NOT NULL,
	`account_short_name` text DEFAULT '' NOT NULL,
	`account_name` text DEFAULT '' NOT NULL,
	`store_name` text DEFAULT '' NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`price` real,
	`target_roi` real DEFAULT 0 NOT NULL,
	`spend` real DEFAULT 0 NOT NULL,
	`net_orders` real DEFAULT 0 NOT NULL,
	`net_amount` real DEFAULT 0 NOT NULL,
	`net_roi` real DEFAULT 0 NOT NULL,
	`compensation` real DEFAULT 0 NOT NULL,
	`latest_status` text DEFAULT '' NOT NULL,
	`effective_orders` real DEFAULT 0 NOT NULL,
	`brush_like` integer DEFAULT 0 NOT NULL,
	`roi_hit` integer DEFAULT 0 NOT NULL,
	`low_order_stop` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `analytics_product_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`store_product_key` text NOT NULL,
	`metric_date` text,
	`is_summary` integer DEFAULT false NOT NULL,
	`business_owner` text,
	`store_name` text NOT NULL,
	`product_id` text NOT NULL,
	`plan_id` text,
	`product_name` text NOT NULL,
	`category_name` text DEFAULT '未登记类目' NOT NULL,
	`submitted_orders` real DEFAULT 0 NOT NULL,
	`one_hour_refund_orders` real DEFAULT 0 NOT NULL,
	`paid_orders` real DEFAULT 0 NOT NULL,
	`pre_ship_refund_orders` real DEFAULT 0 NOT NULL,
	`shipped_orders` real DEFAULT 0 NOT NULL,
	`pending_orders` real DEFAULT 0 NOT NULL,
	`post_ship_refund_orders` real DEFAULT 0 NOT NULL,
	`fake_orders` real DEFAULT 0 NOT NULL,
	`price` real,
	`cost` real,
	`non_fake_orders` real DEFAULT 0 NOT NULL,
	`gmv` real DEFAULT 0 NOT NULL,
	`ad_spend` real DEFAULT 0 NOT NULL,
	`compensation` real DEFAULT 0 NOT NULL,
	`roi` real DEFAULT 0 NOT NULL,
	`compensation_roi` real DEFAULT 0 NOT NULL,
	`profit_margin` real DEFAULT 0 NOT NULL,
	`net_deal_roi` real DEFAULT 0 NOT NULL,
	`actual_profit` real DEFAULT 0 NOT NULL,
	`profit_available` integer DEFAULT true NOT NULL,
	`one_hour_refund_rate` real DEFAULT 0 NOT NULL,
	`net_shipping_rate` real DEFAULT 0 NOT NULL,
	`overall_shipping_rate` real DEFAULT 0 NOT NULL,
	`sign_rate` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `analytics_product_registry` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`store_name` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`category_name` text DEFAULT '未登记类目' NOT NULL,
	`plan_id` text,
	`created_at` integer,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `analytics_reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`check_key` text NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`label` text NOT NULL,
	`expected_value` real,
	`actual_value` real,
	`difference` real,
	`tolerance` real,
	`message` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `analytics_sheet_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`sheet_name` text NOT NULL,
	`sheet_role` text NOT NULL,
	`business_purpose` text NOT NULL,
	`join_keys` text NOT NULL,
	`row_count` integer NOT NULL,
	`data_row_count` integer DEFAULT 0 NOT NULL,
	`last_data_row` integer DEFAULT 0 NOT NULL,
	`column_count` integer NOT NULL,
	`formula_count` integer NOT NULL,
	`formula_pattern_count` integer NOT NULL,
	`formula_error_count` integer NOT NULL,
	`fixed_range_reference_count` integer DEFAULT 0 NOT NULL,
	`fixed_range_risk_count` integer NOT NULL,
	`reference_limit_row` integer,
	`reference_usage` real,
	`hidden_row_count` integer NOT NULL,
	`hidden_sheet` integer DEFAULT false NOT NULL,
	`auto_filter` text,
	`headers` text NOT NULL,
	`dependencies` text NOT NULL,
	`status` text NOT NULL,
	`risk_messages` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `analytics_store_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`metric_date` text NOT NULL,
	`store_name` text NOT NULL,
	`business_owner` text,
	`gmv` real DEFAULT 0 NOT NULL,
	`product_cost` real DEFAULT 0 NOT NULL,
	`pre_ship_refund_amount` real DEFAULT 0 NOT NULL,
	`total_refund_amount` real DEFAULT 0 NOT NULL,
	`post_ship_refund_amount` real DEFAULT 0 NOT NULL,
	`post_ship_refund_orders` real DEFAULT 0 NOT NULL,
	`return_shipping_cost` real DEFAULT 0 NOT NULL,
	`service_fee` real DEFAULT 0 NOT NULL,
	`one_hour_refund_amount` real DEFAULT 0 NOT NULL,
	`compensation_registered` real DEFAULT 0 NOT NULL,
	`compensation_spend` real DEFAULT 0 NOT NULL,
	`ad_spend` real DEFAULT 0 NOT NULL,
	`actual_profit` real DEFAULT 0 NOT NULL,
	`compensation_profit` real DEFAULT 0 NOT NULL,
	`fake_orders` real DEFAULT 0 NOT NULL,
	`paid_orders` real DEFAULT 0 NOT NULL,
	`profit_margin` real DEFAULT 0 NOT NULL,
	`compensation_roi` real DEFAULT 0 NOT NULL,
	`overall_refund_rate` real DEFAULT 0 NOT NULL,
	`one_hour_refund_rate` real DEFAULT 0 NOT NULL,
	`pre_ship_refund_rate` real DEFAULT 0 NOT NULL,
	`post_ship_refund_rate` real DEFAULT 0 NOT NULL,
	`gmv_gap` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `analytics_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text,
	`shot_id` integer NOT NULL,
	`type` text NOT NULL,
	`file_path` text,
	`thumbnail_path` text,
	`provider` text,
	`model` text,
	`prompt` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `auth_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`label` text,
	`created_by_user_id` text,
	`used_by_user_id` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null
);

CREATE UNIQUE INDEX `auth_invites_code_hash_unique` ON `auth_invites` (`code_hash`);
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	`last_login_at` integer
);

CREATE UNIQUE INDEX `auth_users_account_id_unique` ON `auth_users` (`account_id`);
CREATE UNIQUE INDEX `auth_users_username_unique` ON `auth_users` (`username`);
CREATE TABLE `brand_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'luma-admin' NOT NULL,
	`name` text NOT NULL,
	`logo_path` text,
	`primary_color` text,
	`secondary_color` text,
	`font_family` text,
	`watermark` text,
	`intro_template_path` text,
	`outro_template_path` text,
	`is_default` integer DEFAULT true,
	`created_at` integer
);

CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'luma-admin' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`appearance` text,
	`reference_images` text DEFAULT '[]',
	`voice_profile` text,
	`is_default` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer
);

CREATE TABLE `compositions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text,
	`output_path` text,
	`resolution` text DEFAULT '1080p',
	`aspect_ratio` text DEFAULT '9:16',
	`duration` integer,
	`bgm_path` text,
	`tts_enabled` integer DEFAULT false,
	`subtitle_style` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `model_api_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`call_type` text NOT NULL,
	`provider_key` text NOT NULL,
	`channel_id` text,
	`channel_name` text,
	`model` text,
	`source` text NOT NULL,
	`project_id` text,
	`board_workflow_id` text,
	`board_node_id` text,
	`quick_cut_task_id` text,
	`product_production_task_id` text,
	`product_production_job_id` text,
	`parent_call_id` text,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`remote_task_id` text,
	`duration_ms` integer NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`usage_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `model_channels`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_call_id`) REFERENCES `model_api_calls`(`id`) ON UPDATE no action ON DELETE set null
);

CREATE TABLE `model_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`provider_key` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer,
	`updated_at` integer
);

CREATE TABLE `product_production_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'luma-admin' NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`description` text,
	`images` text DEFAULT '[]',
	`price` text,
	`target_audience` text,
	`analysis` text,
	`usage_scenarios` text,
	`negative_constraints` text,
	`video_count` integer DEFAULT 0,
	`created_at` integer,
	`updated_at` integer
);

CREATE TABLE `project_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`version_number` integer DEFAULT 1 NOT NULL,
	`version_type` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`product_analysis` text,
	`config_snapshot` text,
	`is_default` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'luma-admin' NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version_id` text,
	`product_name` text,
	`product_category` text,
	`product_description` text,
	`product_images` text DEFAULT '[]',
	`product_analysis` text,
	`product_id` text,
	`brand_id` text,
	`template_id` text,
	`video_mode` text DEFAULT 'product_closeup',
	`source_type` text DEFAULT 'manual',
	`source_video_url` text,
	`character_id` text,
	`created_at` integer,
	`video_aspect_ratio` text DEFAULT '9:16',
	`video_resolution` text DEFAULT '720p',
	`image_channel_id` text,
	`video_channel_id` text,
	`updated_at` integer
);

CREATE TABLE `quick_cut_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source_root` text NOT NULL,
	`task_root` text NOT NULL,
	`stage` text DEFAULT '等待素材' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`scan` text,
	`analysis_summary` text,
	`plans` text,
	`rows` text DEFAULT '[]' NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` integer,
	`updated_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `script_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'luma-admin' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`video_mode` text,
	`style_type` text,
	`shots` text DEFAULT '[]',
	`source_project_id` text,
	`use_count` integer DEFAULT 0,
	`created_at` integer
);

CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`style_type` text NOT NULL,
	`title` text,
	`total_duration` integer,
	`shots` text DEFAULT '[]',
	`selected` integer DEFAULT false,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer
);

CREATE TABLE `user_feature_entries` (
	`user_id` text NOT NULL,
	`feature_key` text NOT NULL,
	`entry_state` text DEFAULT 'open' NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`user_id`, `feature_key`),
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `user_model_credentials` (
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	PRIMARY KEY(`user_id`, `channel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `model_channels`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `user_model_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `user_video_reference_hosting_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`encrypted_api_secret` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `video_clips` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text,
	`shot_id` integer NOT NULL,
	`asset_id` text,
	`file_path` text,
	`duration` integer,
	`provider` text,
	`model` text,
	`transition_type` text DEFAULT 'ai_start_end',
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `project_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);

