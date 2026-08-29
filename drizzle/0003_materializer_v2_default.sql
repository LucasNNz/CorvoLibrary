INSERT INTO `settings` (`key`, `value`, `updated_at`)
VALUES ('MATERIALIZER_V2_DEFAULT', 'true', unixepoch() * 1000)
ON CONFLICT(`key`) DO UPDATE SET
  `value` = 'true',
  `updated_at` = unixepoch() * 1000;
