CREATE TABLE `vault_group` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`access_all` integer DEFAULT false NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_group_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_group_collection` (
	`group_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`read_only` integer DEFAULT true NOT NULL,
	`hide_passwords` integer DEFAULT false NOT NULL,
	`manage` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_vault_group_collection_group_id_vault_group_id_fk` FOREIGN KEY (`group_id`) REFERENCES `vault_group`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_group_collection_collection_id_vault_collection_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `vault_collection`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_group_member` (
	`group_id` text NOT NULL,
	`membership_id` text NOT NULL,
	CONSTRAINT `fk_vault_group_member_group_id_vault_group_id_fk` FOREIGN KEY (`group_id`) REFERENCES `vault_group`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_group_member_membership_id_vault_membership_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `vault_membership`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_group_collection_unique` ON `vault_group_collection` (`group_id`,`collection_id`);--> statement-breakpoint
CREATE INDEX `vault_group_collection_collection_idx` ON `vault_group_collection` (`collection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_group_member_unique` ON `vault_group_member` (`group_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `vault_group_member_membership_idx` ON `vault_group_member` (`membership_id`);