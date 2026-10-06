CREATE TABLE `vault_attachment` (
	`id` text PRIMARY KEY,
	`cipher_id` text NOT NULL,
	`file_name` text NOT NULL,
	`key` text,
	`size` integer NOT NULL,
	`uploaded` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_attachment_token` (
	`hash` text PRIMARY KEY,
	`attachment_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
