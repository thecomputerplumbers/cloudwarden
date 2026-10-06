CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_project_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `project_org_id_idx` ON `project` (`organization_id`,`id`);