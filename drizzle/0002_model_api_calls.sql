CREATE TABLE `model_api_calls` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `auth_users`(`id`) ON DELETE cascade,
  `call_type` text NOT NULL,
  `provider_key` text NOT NULL,
  `channel_id` text REFERENCES `model_channels`(`id`) ON DELETE set null,
  `channel_name` text,
  `model` text,
  `source` text NOT NULL,
  `project_id` text,
  `board_workflow_id` text,
  `board_node_id` text,
  `quick_cut_task_id` text,
  `parent_call_id` text REFERENCES `model_api_calls`(`id`) ON DELETE set null,
  `attempt_number` integer NOT NULL DEFAULT 1,
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
  `completed_at` integer
);
CREATE INDEX `model_api_calls_user_created_idx` ON `model_api_calls` (`user_id`,`created_at` DESC);
CREATE INDEX `model_api_calls_created_idx` ON `model_api_calls` (`created_at` DESC);
CREATE INDEX `model_api_calls_status_created_idx` ON `model_api_calls` (`status`,`created_at` DESC);
CREATE INDEX `model_api_calls_channel_created_idx` ON `model_api_calls` (`channel_id`,`created_at` DESC);
