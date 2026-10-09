CREATE TABLE `vault_rotation_stage` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `vault_rotation_stage_pk` PRIMARY KEY(`kind`, `id`)
);
