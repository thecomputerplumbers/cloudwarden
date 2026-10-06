CREATE TABLE `vault_cipher_archive` (
	`cipher_id` text NOT NULL,
	`user_id` text NOT NULL,
	`archived_at` integer NOT NULL,
	CONSTRAINT `vault_cipher_archive_pk` PRIMARY KEY(`cipher_id`, `user_id`)
);
