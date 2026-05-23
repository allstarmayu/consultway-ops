CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tender_id` text,
	`company_id` text NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`start_date` text,
	`end_date` text,
	`budget_inr` integer,
	`internal_notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tender_id`) REFERENCES `tenders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `projects_company_id_idx` ON `projects` (`company_id`);--> statement-breakpoint
CREATE INDEX `projects_status_idx` ON `projects` (`status`);--> statement-breakpoint
CREATE INDEX `projects_tender_id_idx` ON `projects` (`tender_id`);--> statement-breakpoint
CREATE INDEX `projects_company_status_idx` ON `projects` (`company_id`,`status`);