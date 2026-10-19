ALTER TABLE `vault_cipher` ADD `served` text;--> statement-breakpoint
ALTER TABLE `vault_cipher` ADD `served_personal` text;--> statement-breakpoint
-- Hand-added: the rendered fields must never outlive the payload they came
-- from, whichever code path writes it.
CREATE TRIGGER `vault_cipher_served_reset` AFTER UPDATE OF `payload` ON `vault_cipher`
BEGIN
  UPDATE `vault_cipher` SET `served` = NULL, `served_personal` = NULL WHERE `id` = NEW.`id`;
END;
