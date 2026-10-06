CREATE TABLE `vault_email_change` (
	`user_id` text PRIMARY KEY,
	`new_email` text NOT NULL,
	`code_hash` text NOT NULL,
	`sent_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_vault_email_change_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
