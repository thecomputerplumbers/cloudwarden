CREATE TABLE `vault_directory_group_grant` (
	`group_id` text NOT NULL,
	`membership_id` text NOT NULL,
	CONSTRAINT `fk_vault_directory_group_grant_group_id_vault_group_id_fk` FOREIGN KEY (`group_id`) REFERENCES `vault_group`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_directory_group_grant_membership_id_vault_membership_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `vault_membership`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_directory_group_grant_unique` ON `vault_directory_group_grant` (`group_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `vault_directory_group_grant_membership_idx` ON `vault_directory_group_grant` (`membership_id`);