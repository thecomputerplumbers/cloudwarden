CREATE TABLE `vault_sso_flow` (
	`id` text PRIMARY KEY,
	`client_state` text NOT NULL,
	`client_challenge` text NOT NULL,
	`client_redirect` text NOT NULL,
	`provider_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`binding_hash` text NOT NULL,
	`provider_code` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	`used_at` integer,
	CONSTRAINT `fk_vault_sso_flow_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `vault_sso_identity` (
	`id` text PRIMARY KEY,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_vault_sso_identity_user_id_vault_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `vault_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_sso_identity_subject_unique` ON `vault_sso_identity` (`issuer`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_sso_identity_user_unique` ON `vault_sso_identity` (`issuer`,`user_id`);