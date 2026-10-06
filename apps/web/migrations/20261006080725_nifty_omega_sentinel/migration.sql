CREATE TABLE `vault_directory_identity` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`external_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`active` integer NOT NULL,
	`membership_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_directory_identity_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_directory_identity_membership_id_vault_membership_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `vault_membership`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_directory_identity_org_external_unique` ON `vault_directory_identity` (`org_id`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_directory_identity_membership_unique` ON `vault_directory_identity` (`membership_id`);