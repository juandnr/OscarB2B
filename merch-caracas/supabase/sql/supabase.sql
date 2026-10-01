-- ── Parte propia de Supabase ────────────────────────────────────────────────
-- Configuración editable, bitácora, secretos en Vault y tareas programadas.

-- Configuración que se edita desde el Table Editor (esquema merch).
-- Los tokens y claves NO van aquí: van en los secretos de la Edge Function.
create table if not exists configuracion (
  clave       text primary key,
  valor       text not null default '',
  descripcion text
);

insert into configuracion (clave, valor, descripcion) values
  ('HORARIO_LABORAL',        '',                  'PENDIENTE. Días y horas de trabajo. Formato: lun-vie 08:00-17:00; sab 08:00-12:00'),
  ('FERIADOS',               '',                  'Opcional. Días sin horario laboral, separados por coma: 2026-12-24,2026-12-25'),
  ('ADMIN_HUBSPOT_OWNER_ID', '',                  'Opcional. ID del usuario de HubSpot que recibe los escalamientos y el resumen general'),
  ('PRODUCCION_HUBSPOT_OWNER_ID', '',             'Opcional. ID del usuario de HubSpot que recibe las tareas "Iniciar producción". Vacío = el vendedor del negocio'),
  ('MODO_SOMBRA',            'true',              'true = F2 solo escribe resumen_ia y una nota. false = mueve etapas y crea tareas'),
  ('F2_ACTIVO',              'false',             'true = analiza los chats con Claude cada 3 minutos'),
  ('F3_ACTIVO',              'false',             'true = revisa los tiempos de respuesta cada 15 minutos (en horario laboral)'),
  ('F4_ACTIVO',              'false',             'true = revisa las tareas completadas cada 5 minutos'),
  ('F5_ACTIVO',              'false',             'true = resumen diario a las 7:30 (días laborables): uno por vendedor y el general al administrador'),
  ('TIMEZONE',               'America/Caracas',   'Zona horaria'),
  ('DEBOUNCE_MIN',           '5',                 'Minutos sin mensajes antes de analizar una conversación'),
  ('SLA_RESPUESTA_NUEVO_MIN','15',                'Minutos laborables para contestar a un cliente nuevo'),
  ('SLA_RESPUESTA_CURSO_MIN','120',               'Minutos laborables para contestar en las demás etapas'),
  ('SLA_SEGUIMIENTO_HORAS',  '48',                'Horas para el seguimiento de una cotización'),
  ('ESCALAR_MIN',            '60',                'Minutos laborables de atraso antes de avisar al administrador'),
  ('ANTHROPIC_MODEL',        'claude-sonnet-5-5', 'Modelo de Claude'),
  ('ANTHROPIC_EFFORT',       'low',               'Esfuerzo de Claude: low, medium o high'),
  ('ANTHROPIC_FALLBACK',     'default',           '"default" reintenta con otro modelo si el principal rechaza; "no" lo apaga'),
  ('F2_LOTE',                '8',                 'Clientes que analiza F2 por corrida'),
  ('F2_TIEMPO_MAXIMO_S',     '80',                'Segundos de análisis por corrida (Supabase corta a los 150)'),
  ('HUBSPOT_PIPELINE_ID',    '',                  'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_NUEVO',            '', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_SOLICITUD',        '', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_COTIZADO',         '', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_VERIFICAR_PAGO',   '', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_PAGADO',           '', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_LISTO_PARA_ENVIAR','', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_ENVIADO',          '', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_ENTREGADO',        '', 'Lo llena hubspot-setup'),
  ('HUBSPOT_ETAPA_PERDIDO',          '', 'Lo llena hubspot-setup')
on conflict (clave) do update set descripcion = excluded.descripcion;  -- nunca pisa el valor

-- Qué hizo la función y con qué resultado (se borra a los 14 días).
create table if not exists bitacora (
  id        bigserial primary key,
  creado_at timestamptz not null default now(),
  ruta      text not null,
  ok        boolean not null,
  detalle   jsonb
);
create index if not exists bitacora_creado_idx on bitacora (creado_at);

-- Extensiones para las tareas programadas.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end $$;

-- Secretos generados al azar en Vault: uno para que solo el cron pueda llamar
-- a la función y otro para el webhook de 360dialog.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'merch_cron_secreto') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'merch_cron_secreto');
  end if;
  if not exists (select 1 from vault.secrets where name = 'merch_webhook_secreto') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'merch_webhook_secreto');
  end if;
end $$;

-- Llama a una ruta de la función (f2, hubspot-setup, configurar-webhook...).
-- La URL la registra la propia función la primera vez que se abre /merch/salud.
create or replace function llamar(ruta text)
returns bigint
language plpgsql as $$
declare
  url     text := (select decrypted_secret from vault.decrypted_secrets where name = 'merch_url_funcion');
  secreto text := (select decrypted_secret from vault.decrypted_secrets where name = 'merch_cron_secreto');
begin
  if url is null then
    raise notice 'Falta registrar la URL de la función: abre …/functions/v1/merch/salud una vez.';
    return null;
  end if;
  return net.http_post(
    url                  := url || '/' || ruta,
    body                 := '{}'::jsonb,
    headers              := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secreto', secreto),
    timeout_milliseconds := 10000
  );
end $$;

-- Tareas programadas. pg_cron usa hora UTC: 11:30 UTC = 7:30 en Caracas.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('merch-f2', '*/3 * * * *',  'select merch.llamar(''f2'')');
    perform cron.schedule('merch-f3', '*/15 * * * *', 'select merch.llamar(''f3'')');
    perform cron.schedule('merch-f4', '*/5 * * * *',  'select merch.llamar(''f4'')');
    perform cron.schedule('merch-f5', '30 11 * * *',  'select merch.llamar(''f5'')');
    perform cron.schedule('merch-limpieza', '15 4 * * *', $c$
      delete from merch.bitacora where creado_at < now() - interval '14 days';
      delete from cron.job_run_details where end_time < now() - interval '7 days';
    $c$);
  end if;
end $$;

-- Las funciones del esquema siempre ven sus tablas, y solo las usa el dueño
-- (la función de Supabase y el cron se conectan como postgres).
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as firma
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'merch'
  loop
    execute format('alter function %s set search_path = merch, public', f.firma);
  end loop;
end $$;

revoke all on all functions in schema merch from public;
alter default privileges in schema merch revoke execute on functions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema merch from anon, authenticated';
  end if;
end $$;
