CREATE TABLE `vault_directory_collection_grant` (
	`id` text PRIMARY KEY,
	`membership_id` text NOT NULL,
	`collection_id` text NOT NULL,
	CONSTRAINT `fk_vault_directory_collection_grant_membership_id_vault_membership_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `vault_membership`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_directory_collection_grant_collection_id_vault_collection_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `vault_collection`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_directory_collection_grant_unique` ON `vault_directory_collection_grant` (`membership_id`,`collection_id`);