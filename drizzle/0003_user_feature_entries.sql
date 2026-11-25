CREATE TABLE `user_feature_entries` (
  `user_id` text NOT NULL REFERENCES `auth_users`(`id`) ON DELETE cascade,
  `feature_key` text NOT NULL,
  `entry_state` text NOT NULL DEFAULT 'open',
  `updated_at` integer,
  PRIMARY KEY (`user_id`, `feature_key`)
);
