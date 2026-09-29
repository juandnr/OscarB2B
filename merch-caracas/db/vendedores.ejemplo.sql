-- Carga de vendedores (PENDIENTE: Oscar define la lista y el orden de rotación).
--
-- hubspot_owner_id: el ID de usuario que imprime `npm run hubspot:setup` al final.
-- orden: posición en la rotación (1, 2, 3...). La rotación sigue este orden y
--        vuelve a empezar; salta a quien tenga disponible = false.
--
-- Copia este archivo, reemplaza los datos de ejemplo y córrelo con psql:
--   psql "$DATABASE_URL" -f db/vendedores.sql

insert into vendedores (nombre, hubspot_owner_id, orden, disponible) values
  ('Vendedor 1', '<hubspot_owner_id>', 1, true),
  ('Vendedor 2', '<hubspot_owner_id>', 2, true);

-- Para sacar a alguien de la rotación (vacaciones, reposo) sin borrarlo:
--   update vendedores set disponible = false where nombre = 'Vendedor 2';
-- Sus clientes actuales lo siguen teniendo como vendedor (cliente que vuelve →
-- mismo vendedor); para pasarlos a otra persona, cambia el propietario del
-- negocio en HubSpot y el sistema lo toma en la siguiente corrida.
