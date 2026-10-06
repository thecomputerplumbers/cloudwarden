ALTER TABLE `vault_session` ADD `previous_access_hash` text;--> statement-breakpoint
ALTER TABLE `vault_session` ADD `previous_access_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_session_previous_access_unique` ON `vault_session` (`previous_access_hash`);