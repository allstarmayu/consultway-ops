PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
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
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "password_hash", "role", "company_id", "name", "is_active", "email_verified_at", "last_login_at", "created_at", "updated_at") SELECT "id", "email", "password_hash", "role", "company_id", "name", "is_active", "email_verified_at", "last_login_at", "created_at", "updated_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_company_id_idx` ON `users` (`company_id`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);