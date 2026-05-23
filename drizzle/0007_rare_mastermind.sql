CREATE TABLE `reminders_sent` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`reminder_kind` text NOT NULL,
	`sent_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_sent_document_kind_unique_idx` ON `reminders_sent` (`document_id`,`reminder_kind`);--> statement-breakpoint
CREATE INDEX `reminders_sent_document_id_idx` ON `reminders_sent` (`document_id`);