ALTER TABLE `vault_session` ADD `device_type` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_session` ADD `client_id` text DEFAULT 'unknown' NOT NULL;