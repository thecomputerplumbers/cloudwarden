CREATE TABLE `vault_send_download_token` (
	`hash` text PRIMARY KEY,
	`send_id` text NOT NULL,
	`file_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `vault_send` ADD `uploaded` integer DEFAULT true NOT NULL;