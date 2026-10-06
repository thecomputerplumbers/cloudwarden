ALTER TABLE `vault_cipher_transfer` ADD `prepared` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_cipher_transfer` ADD `lease_id` text;--> statement-breakpoint
ALTER TABLE `vault_cipher_transfer` ADD `lease_until` integer;