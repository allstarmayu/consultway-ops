CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sector` text NOT NULL,
	`geography` text NOT NULL,
	`gst_number` text,
	`pan_number` text,
	`is_msme` integer DEFAULT false NOT NULL,
	`is_jv` integer DEFAULT false NOT NULL,
	`compliance_status` text DEFAULT 'pending' NOT NULL,
	`parent_company_ids` text,
	`contact_email` text,
	`contact_phone` text,
	`contact_person_name` text,
	`address_line` text,
	`city` text,
	`state` text,
	`pincode` text,
	`internal_notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_gst_number_unique` ON `companies` (`gst_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `companies_pan_number_unique` ON `companies` (`pan_number`);--> statement-breakpoint
CREATE INDEX `companies_name_idx` ON `companies` (`name`);--> statement-breakpoint
CREATE INDEX `companies_sector_idx` ON `companies` (`sector`);--> statement-breakpoint
CREATE INDEX `companies_geography_idx` ON `companies` (`geography`);--> statement-breakpoint
CREATE INDEX `companies_compliance_status_idx` ON `companies` (`compliance_status`);--> statement-breakpoint
CREATE INDEX `companies_is_jv_idx` ON `companies` (`is_jv`);