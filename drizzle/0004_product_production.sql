ALTER TABLE `model_api_calls` ADD `product_production_task_id` text;
--> statement-breakpoint
ALTER TABLE `model_api_calls` ADD `product_production_job_id` text;
--> statement-breakpoint
CREATE INDEX `model_api_calls_product_production_idx` ON `model_api_calls` (`product_production_task_id`,`created_at`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `product_production_owner_updated_idx` ON `product_production_tasks` (`owner_id`,`updated_at`);
