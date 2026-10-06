CREATE TABLE `vault_cipher_transfer` (
	`cipher_id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_vault_cipher_transfer_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_cipher_transfer_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE
);
