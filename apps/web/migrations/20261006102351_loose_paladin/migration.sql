CREATE TABLE `vault_protected_otp` (
	`user_id` text PRIMARY KEY,
	`code_hash` text NOT NULL,
	`sent_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_vault_protected_otp_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
