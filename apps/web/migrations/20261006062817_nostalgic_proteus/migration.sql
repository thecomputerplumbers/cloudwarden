CREATE TABLE `vault_session` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`access_hash` text NOT NULL,
	`refresh_hash` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	CONSTRAINT `fk_vault_session_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_user` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`key` text NOT NULL,
	`private_key` text,
	`public_key` text,
	`kdf` integer NOT NULL,
	`kdf_iterations` integer NOT NULL,
	`kdf_memory` integer,
	`kdf_parallelism` integer,
	`security_stamp` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_session_access_unique` ON `vault_session` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_session_refresh_unique` ON `vault_session` (`refresh_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_user_email_unique` ON `vault_user` (`email`);