CREATE USER 'maxwell'@'%' IDENTIFIED BY 'maxwell-local-only';
GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'maxwell'@'%';
GRANT ALL PRIVILEGES ON maxwell.* TO 'maxwell'@'%';
CREATE USER 'cdc'@'%' IDENTIFIED BY 'cdc-local-only';
GRANT ALL PRIVILEGES ON poc.* TO 'cdc'@'%';
GRANT REPLICATION CLIENT ON *.* TO 'cdc'@'%';
