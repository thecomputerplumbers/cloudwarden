ALTER TABLE `vault_session` ADD `sso_issuer` text;--> statement-breakpoint
ALTER TABLE `vault_session` ADD `sso_refresh_token` text;--> statement-breakpoint
ALTER TABLE `vault_sso_flow` ADD `provider_refresh_token` text;