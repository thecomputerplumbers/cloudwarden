CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_invitation_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_invitation_inviter_id_user_id_fk` FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_member_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_member_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`active_organization_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_customer` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`email` text,
	`livemode` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_event` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`livemode` integer DEFAULT false NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_subscription` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`price_id` text,
	`quantity` integer,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`canceled_at` integer,
	`trial_end` integer,
	`livemode` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_identity_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `invitation_organization_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE INDEX `member_organization_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_user_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_org_user_idx` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `organization_slug_idx` ON `organization` (`slug`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_customer_organization_idx` ON `stripe_customer` (`organization_id`);--> statement-breakpoint
CREATE INDEX `stripe_event_type_idx` ON `stripe_event` (`type`);--> statement-breakpoint
CREATE INDEX `stripe_subscription_organization_idx` ON `stripe_subscription` (`organization_id`);--> statement-breakpoint
CREATE INDEX `stripe_subscription_customer_idx` ON `stripe_subscription` (`customer_id`);--> statement-breakpoint
CREATE INDEX `stripe_subscription_status_idx` ON `stripe_subscription` (`status`);