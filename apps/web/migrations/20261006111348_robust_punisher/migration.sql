ALTER TABLE `vault_device` ADD `two_factor_remember_hash` text;--> statement-breakpoint
ALTER TABLE `vault_device` ADD `two_factor_remember_expires_at` integer;