CREATE TABLE `vault_device` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`device_type` integer NOT NULL,
	`device_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_vault_device_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_device_user_device_unique` ON `vault_device` (`user_id`,`device_id`);