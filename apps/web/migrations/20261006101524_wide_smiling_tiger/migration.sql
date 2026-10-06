CREATE TABLE `vault_api_key` (
	`user_id` text PRIMARY KEY,
	`secret_hash` text NOT NULL,
	`sealed_secret` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_api_key_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `vault_session` ADD `api_key` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_session` ADD `api_key_hash` text;