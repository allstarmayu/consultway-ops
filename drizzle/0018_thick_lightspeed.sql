CREATE TABLE `tender_invited_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`tender_id` text NOT NULL,
	`company_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`tender_id`) REFERENCES `tenders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tender_invited_companies_tender_company_unique_idx` ON `tender_invited_companies` (`tender_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `tender_invited_companies_company_id_idx` ON `tender_invited_companies` (`company_id`);--> statement-breakpoint
CREATE INDEX `tender_invited_companies_tender_id_idx` ON `tender_invited_companies` (`tender_id`);--> statement-breakpoint
ALTER TABLE `tenders` ADD `visibility` text DEFAULT 'open' NOT NULL;