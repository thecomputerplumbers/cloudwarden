CREATE TABLE `vault_auth_request` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`request_device_id` text NOT NULL,
	`device_type` integer NOT NULL,
	`request_ip` text NOT NULL,
	`access_code_hash` text NOT NULL,
	`public_key` text NOT NULL,
	`encrypted_key` text,
	`sealed_master_password_hash` text,
	`approved` integer,
	`created_at` integer NOT NULL,
	`response_at` integer,
	`authenticated_at` integer,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_vault_auth_request_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `vault_auth_request_user_idx` ON `vault_auth_request` (`user_id`);