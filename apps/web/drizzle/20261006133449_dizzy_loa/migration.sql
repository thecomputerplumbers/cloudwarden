CREATE TABLE `vault_cipher_preference` (
	`cipher_id` text PRIMARY KEY,
	`folder_id` text,
	`favorite` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
