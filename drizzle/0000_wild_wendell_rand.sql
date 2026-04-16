CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`company_id` text,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`email_verified_at` text,
	`last_login_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_company_id_idx` ON `users` (`company_id`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);