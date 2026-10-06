CREATE TABLE `vault_email_two_factor` (
	`user_id` text PRIMARY KEY,
	`email` text,
	`pending_email` text,
	`pending_code_hash` text,
	`pending_code_expires_at` integer,
	`login_code_hash` text,
	`login_code_expires_at` integer,
	`login_attempts` integer DEFAULT 0 NOT NULL,
	`recovery_code` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_email_two_factor_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
