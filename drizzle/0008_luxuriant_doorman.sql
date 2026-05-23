ALTER TABLE `tenders` ADD `awarded_company_id` text REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict;--> statement-breakpoint
CREATE INDEX `tenders_awarded_company_id_idx` ON `tenders` (`awarded_company_id`);
