CREATE TABLE `vault_cipher` (
	`id` text PRIMARY KEY,
	`payload` text NOT NULL,
	`revision` integer NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_folder` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
