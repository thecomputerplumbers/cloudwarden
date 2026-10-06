CREATE TABLE `vault_send` (
	`id` text PRIMARY KEY,
	`payload` text NOT NULL,
	`password_hash` text,
	`password_salt` text,
	`access_count` integer DEFAULT 0 NOT NULL,
	`max_access_count` integer,
	`expiration_at` integer,
	`deletion_at` integer NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_send_token` (
	`hash` text PRIMARY KEY,
	`send_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
