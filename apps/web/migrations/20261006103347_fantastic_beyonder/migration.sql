ALTER TABLE `vault_session` ADD `device_name` text DEFAULT 'Unknown device' NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_session` ADD `created_at` integer;--> statement-breakpoint
CREATE INDEX `vault_session_user_device_idx` ON `vault_session` (`user_id`,`device_id`);--> statement-breakpoint
UPDATE `vault_session`
SET `created_at` = `refresh_expires_at` - 2592000000
WHERE `created_at` IS NULL;
