CREATE TABLE `tender_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`tender_id` text NOT NULL,
	`company_id` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`cover_note` text,
	`internal_notes` text,
	`submitted_at` text DEFAULT (datetime('now')) NOT NULL,
	`decided_at` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tender_id`) REFERENCES `tenders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tender_applications_tender_company_unique_idx` ON `tender_applications` (`tender_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `tender_applications_tender_id_idx` ON `tender_applications` (`tender_id`);--> statement-breakpoint
CREATE INDEX `tender_applications_company_id_idx` ON `tender_applications` (`company_id`);--> statement-breakpoint
CREATE INDEX `tender_applications_status_idx` ON `tender_applications` (`status`);--> statement-breakpoint
CREATE TABLE `tenders` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`reference_number` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`publisher_company_id` text NOT NULL,
	`sector` text NOT NULL,
	`geography` text NOT NULL,
	`eligible_sector` text,
	`eligible_geography` text,
	`min_annual_turnover_inr` integer,
	`msme_only` integer DEFAULT false NOT NULL,
	`opening_date` text,
	`closing_date` text,
	`internal_notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`published_at` text,
	FOREIGN KEY (`publisher_company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenders_reference_number_unique` ON `tenders` (`reference_number`);--> statement-breakpoint
CREATE INDEX `tenders_title_idx` ON `tenders` (`title`);--> statement-breakpoint
CREATE INDEX `tenders_status_idx` ON `tenders` (`status`);--> statement-breakpoint
CREATE INDEX `tenders_publisher_company_id_idx` ON `tenders` (`publisher_company_id`);--> statement-breakpoint
CREATE INDEX `tenders_sector_idx` ON `tenders` (`sector`);--> statement-breakpoint
CREATE INDEX `tenders_closing_date_idx` ON `tenders` (`closing_date`);