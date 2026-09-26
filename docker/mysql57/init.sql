CREATE USER 'cdc'@'%' IDENTIFIED BY 'cdc-local-only';
GRANT ALL PRIVILEGES ON poc.* TO 'cdc'@'%';
GRANT ALL PRIVILEGES ON cdc_meta.* TO 'cdc'@'%';
