CREATE TABLE `vault_emergency_access` (
	`id` text PRIMARY KEY,
	`grantor_id` text NOT NULL,
	`grantee_id` text,
	`email` text,
	`key_encrypted` text,
	`type` integer NOT NULL,
	`status` integer NOT NULL,
	`wait_time_days` integer NOT NULL,
	`recovery_initiated_at` integer,
	`last_notification_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_emergency_access_grantor_id_vault_user_id_fk` FOREIGN KEY (`grantor_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_emergency_access_grantee_id_vault_user_id_fk` FOREIGN KEY (`grantee_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_passkey_challenge` (
	`id` text PRIMARY KEY,
	`user_id` text,
	`scope` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_vault_passkey_challenge_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_passkey_credential` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`slot` integer NOT NULL,
	`name` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`supports_prf` integer NOT NULL,
	`encrypted_user_key` text,
	`encrypted_public_key` text,
	`encrypted_private_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_passkey_credential_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `vault_user` ADD `user_key_id` text;--> statement-breakpoint
ALTER TABLE `vault_user` ADD `avatar_color` text;--> statement-breakpoint
ALTER TABLE `vault_user` ADD `equivalent_domains` text;--> statement-breakpoint
ALTER TABLE `vault_user` ADD `excluded_global_domains` text;--> statement-breakpoint
ALTER TABLE `vault_user` ADD `rotation_token` text;--> statement-breakpoint
ALTER TABLE `vault_user` ADD `rotation_state` text;--> statement-breakpoint
ALTER TABLE `vault_user` ADD `rotation_started_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_emergency_access_grantor_email_unique` ON `vault_emergency_access` (`grantor_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_emergency_access_grantor_grantee_unique` ON `vault_emergency_access` (`grantor_id`,`grantee_id`);--> statement-breakpoint
CREATE INDEX `vault_emergency_access_grantee_idx` ON `vault_emergency_access` (`grantee_id`);--> statement-breakpoint
CREATE INDEX `vault_emergency_access_status_idx` ON `vault_emergency_access` (`status`);--> statement-breakpoint
CREATE INDEX `vault_passkey_challenge_expires_idx` ON `vault_passkey_challenge` (`expires_at`);--> statement-breakpoint
CREATE INDEX `vault_passkey_challenge_user_idx` ON `vault_passkey_challenge` (`user_id`,`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_passkey_user_slot_unique` ON `vault_passkey_credential` (`user_id`,`slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_passkey_credential_id_unique` ON `vault_passkey_credential` (`credential_id`);