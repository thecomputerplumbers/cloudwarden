CREATE TABLE `vault_org_import` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`lease_id` text,
	`lease_until` integer,
	CONSTRAINT `fk_vault_org_import_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_org_import_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
