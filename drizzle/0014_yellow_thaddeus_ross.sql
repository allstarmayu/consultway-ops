CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`theme_id` text DEFAULT 'warm-ambient' NOT NULL,
	`density` text DEFAULT 'comfortable' NOT NULL,
	`reduced_motion` integer DEFAULT false NOT NULL,
	`weekly_digest` integer DEFAULT true NOT NULL,
	`monthly_report` integer DEFAULT false NOT NULL,
	`document_expiry` integer DEFAULT true NOT NULL,
	`tender_alerts` integer DEFAULT true NOT NULL,
	`assignment_alerts` integer DEFAULT true NOT NULL,
	`incident_alerts` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
