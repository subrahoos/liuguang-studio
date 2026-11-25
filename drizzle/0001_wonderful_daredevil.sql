CREATE TABLE `user_video_reference_hosting_credentials` (
  `user_id` text PRIMARY KEY NOT NULL,
  `encrypted_api_key` text NOT NULL,
  `encrypted_api_secret` text NOT NULL,
  `key_version` integer DEFAULT 1 NOT NULL,
  `created_at` integer,
  `updated_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
