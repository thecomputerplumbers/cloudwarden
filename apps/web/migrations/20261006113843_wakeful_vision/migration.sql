CREATE TABLE `vault_webauthn_challenge` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_vault_webauthn_challenge_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_webauthn_credential` (
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_webauthn_credential_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_webauthn_factor` (
	`user_id` text PRIMARY KEY,
	`recovery_code` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_vault_webauthn_factor_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_webauthn_user_slot_unique` ON `vault_webauthn_credential` (`user_id`,`slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_webauthn_credential_id_unique` ON `vault_webauthn_credential` (`credential_id`);