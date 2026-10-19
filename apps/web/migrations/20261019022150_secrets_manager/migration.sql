CREATE TABLE `sm_access_token` (
	`id` text PRIMARY KEY,
	`machine_account_id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_sm_access_token_machine_account_id_sm_machine_account_id_fk` FOREIGN KEY (`machine_account_id`) REFERENCES `sm_machine_account`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sm_access_token_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sm_machine_access` (
	`machine_account_id` text NOT NULL,
	`project_id` text NOT NULL,
	`write` integer DEFAULT false NOT NULL,
	CONSTRAINT `sm_machine_access_pk` PRIMARY KEY(`machine_account_id`, `project_id`),
	CONSTRAINT `fk_sm_machine_access_machine_account_id_sm_machine_account_id_fk` FOREIGN KEY (`machine_account_id`) REFERENCES `sm_machine_account`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sm_machine_access_project_id_sm_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sm_project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sm_machine_account` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sm_machine_account_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sm_project` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sm_project_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sm_secret` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sm_secret_org_id_vault_organization_id_fk` FOREIGN KEY (`org_id`) REFERENCES `vault_organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sm_secret_project_id_sm_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sm_project`(`id`)
);
--> statement-breakpoint
CREATE INDEX `sm_access_token_machine_idx` ON `sm_access_token` (`machine_account_id`);--> statement-breakpoint
CREATE INDEX `sm_machine_account_org_idx` ON `sm_machine_account` (`org_id`);--> statement-breakpoint
CREATE INDEX `sm_project_org_idx` ON `sm_project` (`org_id`);--> statement-breakpoint
CREATE INDEX `sm_secret_org_idx` ON `sm_secret` (`org_id`);--> statement-breakpoint
CREATE INDEX `sm_secret_project_idx` ON `sm_secret` (`project_id`);