-- Se ejecuta solo la primera vez que arranca Postgres (volumen vacío).
-- Crea la base del sistema; las tablas las crea `npm run db:migrar`.
create database merch;
