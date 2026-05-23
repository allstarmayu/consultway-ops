CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`company_id` text NOT NULL,
	`project_id` text,
	`occurred_on` text NOT NULL,
	`reference_number` text,
	`notes` text,
	`internal_notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_reference_number_unique` ON `transactions` (`reference_number`);--> statement-breakpoint
CREATE INDEX `transactions_company_id_idx` ON `transactions` (`company_id`);--> statement-breakpoint
CREATE INDEX `transactions_project_id_idx` ON `transactions` (`project_id`);--> statement-breakpoint
CREATE INDEX `transactions_type_idx` ON `transactions` (`type`);--> statement-breakpoint
CREATE INDEX `transactions_occurred_on_idx` ON `transactions` (`occurred_on`);--> statement-breakpoint
CREATE INDEX `transactions_company_type_idx` ON `transactions` (`company_id`,`type`);--> statement-breakpoint
CREATE INDEX `transactions_project_type_idx` ON `transactions` (`project_id`,`type`);