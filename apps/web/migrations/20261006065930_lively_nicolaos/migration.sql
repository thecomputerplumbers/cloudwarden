CREATE TABLE `vault_totp` (
	`user_id` text PRIMARY KEY,
	`secret` text NOT NULL,
	`last_used_step` integer DEFAULT 0 NOT NULL,
	`recovery_code` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_vault_totp_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
