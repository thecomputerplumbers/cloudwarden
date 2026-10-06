ALTER TABLE `vault_session` ADD `security_stamp` text;--> statement-breakpoint
UPDATE `vault_session`
SET `security_stamp` = (
  SELECT `security_stamp` FROM `vault_user`
  WHERE `vault_user`.`id` = `vault_session`.`user_id`
);
