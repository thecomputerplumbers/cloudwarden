CREATE TABLE `vault_collection` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_collection_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_collection_member` (
	`collection_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`hide_passwords` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_vault_collection_member_collection_id_vault_collection_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `vault_collection`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_collection_member_membership_id_vault_membership_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `vault_membership`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_membership` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key` text,
	`role` integer NOT NULL,
	`status` integer NOT NULL,
	`access_all` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_vault_membership_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_membership_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_org_cipher` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_vault_org_cipher_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_org_cipher_collection` (
	`cipher_id` text NOT NULL,
	`collection_id` text NOT NULL,
	CONSTRAINT `fk_vault_org_cipher_collection_cipher_id_vault_org_cipher_id_fk` FOREIGN KEY (`cipher_id`) REFERENCES `vault_org_cipher`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vault_org_cipher_collection_collection_id_vault_collection_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `vault_collection`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vault_organization` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`billing_email` text NOT NULL,
	`public_key` text,
	`private_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_collection_member_unique` ON `vault_collection_member` (`collection_id`,`membership_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_membership_org_user_unique` ON `vault_membership` (`org_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_org_cipher_collection_unique` ON `vault_org_cipher_collection` (`cipher_id`,`collection_id`);