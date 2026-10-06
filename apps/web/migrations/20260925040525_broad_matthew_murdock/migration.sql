PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organization` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`logo` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_organization`(`id`, `name`, `slug`, `logo`, `metadata`, `created_at`) SELECT `id`, `name`, `slug`, `logo`, `metadata`, `created_at` FROM `organization`;--> statement-breakpoint
DROP TABLE `organization`;--> statement-breakpoint
ALTER TABLE `__new_organization` RENAME TO `organization`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `organization_slug_idx` ON `organization` (`slug`);