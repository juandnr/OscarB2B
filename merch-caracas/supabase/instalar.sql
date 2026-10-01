-- Merch Caracas · instalación en Supabase
-- Generado por supabase/construir.js. Pégalo completo en el SQL Editor de tu
-- proyecto y ejecútalo. Se puede volver a correr: no borra ni duplica nada.

create schema if not exists merch;
set search_path = merch, public;

create table if not exists schema_migraciones (
  version     text primary key,
  aplicada_at timestamptz not null default now()
);

-- 001_esquema.sql
do $migracion$
begin
  if not exists (select 1 from merch.schema_migraciones where version = '001_esquema.sql') then
    execute $m_001_esquema_sql$
-- 001 — Esquema base (tal cual la especificación).
-- Las columnas y tablas que agrega la implementación van en 002.

create table vendedores (
  id serial primary key,
  nombre text not null,
  hubspot_owner_id text not null unique,
  disponible boolean not null default true,
  orden int not null
);

create table rotacion (
  id int primary key default 1,
  ultimo_vendedor_id int references vendedores(id)
);

create table clientes (
  telefono text primary key,             -- E.164
  nombre_wa text,
  vendedor_id int references vendedores(id),
  hubspot_contact_id text,
  hubspot_deal_id text,
  etapa text not null default 'nuevo',
  ultimo_msg_cliente_at timestamptz,
  ultimo_msg_empresa_at timestamptz,
  pendiente_analisis boolean not null default false,
  ultimo_analisis_at timestamptz,
  creado_at timestamptz not null default now()
);

create table mensajes (
  id text primary key,                   -- wamid de Meta (deduplicación)
  telefono text not null references clientes(telefono),
  direccion text not null check (direccion in ('entrante','saliente')),
  tipo text not null,                    -- text, image, document, audio...
  texto text,
  media_id text,
  ts timestamptz not null,
  raw jsonb not null
);
create index on mensajes (telefono, ts);

create table tareas (
  hubspot_task_id text primary key,
  telefono text not null references clientes(telefono),
  tipo text not null,                    -- contestar, cotizar, seguimiento, verificar_pago, produccion, enviar, confirmar
  estado text not null default 'abierta',-- abierta, completada
  creada_at timestamptz not null default now(),
  completada_at timestamptz
);
$m_001_esquema_sql$;
    insert into merch.schema_migraciones (version) values ('001_esquema.sql');
  end if;
end $migracion$;

-- 002_implementacion.sql
do $migracion$
begin
  if not exists (select 1 from merch.schema_migraciones where version = '002_implementacion.sql') then
    execute $m_002_implementacion_sql$
-- 002 — Columnas, tablas y funciones que agrega la implementación sobre el esquema base.
--
-- Las funciones concentran en Postgres lo que tiene que ser atómico (deduplicar
-- mensajes, rotación, candados para no procesar dos veces al mismo cliente).
-- n8n solo las llama con un parámetro jsonb.

-- ── Columnas nuevas ─────────────────────────────────────────────────────────

alter table clientes
  add column alta_intentada_at  timestamptz,               -- candado de F1 para crear contacto/negocio una sola vez
  add column analisis_tomado_at timestamptz,               -- candado de F2 mientras analiza a este cliente
  add column analisis_corte     timestamptz,               -- último mensaje incluido en el análisis en curso
  add column analisis_fallos    int not null default 0;    -- fallos seguidos de F2 (a los 5 deja de reintentar)

alter table mensajes
  add column origen text not null default 'messages'
    check (origen in ('messages', 'echo', 'history'));     -- webhook del que vino

alter table tareas
  add column hubspot_deal_id text,                         -- negocio al que quedó asociada
  add column vence_at        timestamptz,                  -- fecha límite puesta en HubSpot
  add column escalada_at     timestamptz;                  -- cuándo F3 avisó al administrador

create index tareas_abiertas_idx on tareas (telefono, tipo) where estado = 'abierta';
create index clientes_pendientes_idx on clientes (telefono) where pendiente_analisis;

insert into rotacion (id) values (1) on conflict do nothing;

-- Registro de cada análisis de F2. Sirve para auditar y para la revisión manual
-- del modo sombra (columnas revision_*).
create table analisis (
  id                bigserial primary key,
  telefono          text not null references clientes(telefono),
  hubspot_deal_id   text,
  creado_at         timestamptz not null default now(),
  modo              text not null check (modo in ('sombra', 'activo')),
  etapa_antes       text,
  etapa_detectada   text,
  confianza         numeric,
  etapa_aplicada    text,          -- etapa a la que se movió el negocio (null si no se movió)
  resultado         jsonb,         -- JSON devuelto por Claude
  decision          jsonb,         -- lo que decidieron las reglas: tareas, descartes, nota
  error             text,
  tokens            jsonb,         -- usage de la API de Claude
  revision_correcta boolean,       -- la llena quien revisa a mano
  revision_nota     text
);
create index on analisis (telefono, creado_at);


-- ── F1: registrar mensajes ──────────────────────────────────────────────────
-- Recibe un arreglo de mensajes normalizados:
--   [{id, telefono, direccion, tipo, texto, media_id, ts, nombre_wa, origen, raw}]
-- Inserta los nuevos (los repetidos se ignoran), crea/actualiza clientes y
-- devuelve una fila por cliente con mensajes nuevos.
--   necesita_alta: hay que buscar/crear contacto y negocio en HubSpot
--                  (primer mensaje en vivo del cliente y todavía sin negocio).
--   tareas_contestar_completar: tareas "contestar" abiertas que ya quedaron
--                  respondidas por un mensaje saliente.
create or replace function f1_registrar_mensajes(p_mensajes jsonb)
returns table (
  telefono                   text,
  nombre_wa                  text,
  necesita_alta              boolean,
  vendedor_id                int,
  hubspot_contact_id         text,
  hubspot_deal_id            text,
  etapa                      text,
  tareas_contestar_completar text[]
)
language plpgsql as $$
#variable_conflict use_column
declare
  v_nuevos jsonb;
begin
  insert into clientes as c (telefono, nombre_wa)
  select distinct on (m.telefono) m.telefono, m.nombre_wa
  from jsonb_to_recordset(p_mensajes) as m(telefono text, nombre_wa text, ts timestamptz)
  order by m.telefono, (m.nombre_wa is null), m.ts desc
  on conflict (telefono) do update
    set nombre_wa = coalesce(excluded.nombre_wa, c.nombre_wa);

  with ins as (
    insert into mensajes (id, telefono, direccion, tipo, texto, media_id, ts, raw, origen)
    select m.id, m.telefono, m.direccion, m.tipo, m.texto, m.media_id, m.ts,
           coalesce(m.raw, '{}'::jsonb), coalesce(m.origen, 'messages')
    from jsonb_to_recordset(p_mensajes) as m(
      id text, telefono text, direccion text, tipo text, texto text,
      media_id text, ts timestamptz, raw jsonb, origen text)
    on conflict (id) do nothing
    returning mensajes.telefono, mensajes.direccion, mensajes.tipo, mensajes.ts, mensajes.origen
  )
  select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_nuevos from ins;

  -- Las reacciones y los mensajes de sistema no cuentan como mensaje ni como respuesta.
  with a as (
    select n.telefono,
           max(n.ts) filter (where n.direccion = 'entrante' and n.tipo not in ('reaction', 'system')) as max_ent,
           max(n.ts) filter (where n.direccion = 'saliente' and n.tipo not in ('reaction', 'system')) as max_sal,
           bool_or(n.origen <> 'history') as hay_vivo
    from jsonb_to_recordset(v_nuevos) as n(telefono text, direccion text, tipo text, ts timestamptz, origen text)
    group by n.telefono
  )
  update clientes c set
    ultimo_msg_cliente_at = greatest(c.ultimo_msg_cliente_at, a.max_ent),
    ultimo_msg_empresa_at = greatest(c.ultimo_msg_empresa_at, a.max_sal),
    pendiente_analisis    = c.pendiente_analisis or a.hay_vivo,
    analisis_fallos       = case when a.hay_vivo then 0 else c.analisis_fallos end
  from a
  where c.telefono = a.telefono;

  return query
  with a as (
    select n.telefono,
           bool_or(n.direccion = 'entrante' and n.origen = 'messages') as entrante_vivo,
           bool_or(n.direccion = 'saliente' and n.origen <> 'history'
                   and n.tipo not in ('reaction', 'system')) as saliente_vivo
    from jsonb_to_recordset(v_nuevos) as n(telefono text, direccion text, tipo text, ts timestamptz, origen text)
    group by n.telefono
  ),
  alta as (
    update clientes c set alta_intentada_at = now()
    from a
    where c.telefono = a.telefono
      and a.entrante_vivo
      and c.hubspot_deal_id is null
      and (c.alta_intentada_at is null or c.alta_intentada_at < now() - interval '5 minutes')
    returning c.telefono
  )
  select c.telefono, c.nombre_wa, (alta.telefono is not null), c.vendedor_id,
         c.hubspot_contact_id, c.hubspot_deal_id, c.etapa,
         case when a.saliente_vivo
                   and c.ultimo_msg_empresa_at >= coalesce(c.ultimo_msg_cliente_at, '-infinity'::timestamptz)
              then array(select t.hubspot_task_id from tareas t
                         where t.telefono = c.telefono and t.tipo = 'contestar' and t.estado = 'abierta')
              else '{}'::text[] end
  from a
  join clientes c on c.telefono = a.telefono
  left join alta on alta.telefono = a.telefono;
end $$;


-- ── F1: asignar vendedor ────────────────────────────────────────────────────
-- Recibe [{telefono, hubspot_owner_id}] donde hubspot_owner_id es el propietario
-- de un negocio previo encontrado en HubSpot (o null).
-- Orden de preferencia: vendedor ya asignado en clientes → propietario previo en
-- HubSpot (si está en la tabla vendedores) → siguiente disponible en la rotación.
create or replace function f1_asignar_vendedor(p_asignaciones jsonb)
returns table (
  telefono         text,
  vendedor_id      int,
  hubspot_owner_id text,
  vendedor_nombre  text,
  metodo           text     -- existente | hubspot | rotacion
)
language plpgsql as $$
#variable_conflict use_column
declare
  r          record;
  v_cliente  clientes%rowtype;
  v_vendedor vendedores%rowtype;
  v_ultimo   vendedores%rowtype;
  v_metodo   text;
begin
  for r in
    select * from jsonb_to_recordset(p_asignaciones) as x(telefono text, hubspot_owner_id text)
  loop
    select * into v_cliente from clientes where clientes.telefono = r.telefono for update;
    if not found then
      raise exception 'El cliente % no existe', r.telefono;
    end if;

    v_vendedor := null;
    v_metodo := null;

    if v_cliente.vendedor_id is not null then
      select * into v_vendedor from vendedores where vendedores.id = v_cliente.vendedor_id;
      v_metodo := 'existente';
    end if;

    if v_vendedor.id is null and r.hubspot_owner_id is not null then
      select * into v_vendedor from vendedores where vendedores.hubspot_owner_id = r.hubspot_owner_id;
      if found then
        v_metodo := 'hubspot';
      end if;
    end if;

    if v_vendedor.id is null then
      perform 1 from rotacion where rotacion.id = 1 for update;
      v_ultimo := null;
      select v.* into v_ultimo
      from rotacion ro join vendedores v on v.id = ro.ultimo_vendedor_id
      where ro.id = 1;

      select v.* into v_vendedor
      from vendedores v
      where v.disponible
      order by case when v_ultimo.id is not null and (v.orden, v.id) > (v_ultimo.orden, v_ultimo.id)
                    then 0 else 1 end,
               v.orden, v.id
      limit 1;
      if not found then
        raise exception 'No hay vendedores disponibles para asignar el cliente %', r.telefono;
      end if;

      update rotacion set ultimo_vendedor_id = v_vendedor.id where rotacion.id = 1;
      v_metodo := 'rotacion';
    end if;

    update clientes set vendedor_id = v_vendedor.id where clientes.telefono = r.telefono;

    telefono := r.telefono;
    vendedor_id := v_vendedor.id;
    hubspot_owner_id := v_vendedor.hubspot_owner_id;
    vendedor_nombre := v_vendedor.nombre;
    metodo := v_metodo;
    return next;
  end loop;
end $$;


-- ── Cambios genéricos (F1, F3, F4) ─────────────────────────────────────────
-- p = {
--   clientes:      [{telefono, hubspot_contact_id?, hubspot_deal_id?, etapa?,
--                    hubspot_owner_id?, alta_completa?, limpiar_deal?}],
--   tareas_nuevas: [{hubspot_task_id, telefono, tipo, vence_at, hubspot_deal_id}],
--   tareas_estado: [{hubspot_task_id, estado?, completada_at?, escalada_at?}]
-- }
-- Los campos null no pisan lo que ya hay.
create or replace function registrar_cambios(p jsonb)
returns jsonb
language plpgsql as $$
declare
  n_clientes int;
  n_nuevas   int;
  n_estado   int;
begin
  update clientes c set
    hubspot_contact_id = coalesce(x.hubspot_contact_id, c.hubspot_contact_id),
    hubspot_deal_id    = case when coalesce(x.limpiar_deal, false) then null
                              else coalesce(x.hubspot_deal_id, c.hubspot_deal_id) end,
    etapa              = coalesce(x.etapa, c.etapa),
    vendedor_id        = coalesce((select v.id from vendedores v where v.hubspot_owner_id = x.hubspot_owner_id),
                                  c.vendedor_id),
    alta_intentada_at  = case when coalesce(x.alta_completa, false) then null else c.alta_intentada_at end
  from jsonb_to_recordset(coalesce(p -> 'clientes', '[]'::jsonb)) as x(
    telefono text, hubspot_contact_id text, hubspot_deal_id text, etapa text,
    hubspot_owner_id text, alta_completa boolean, limpiar_deal boolean)
  where c.telefono = x.telefono;
  get diagnostics n_clientes = row_count;

  insert into tareas (hubspot_task_id, telefono, tipo, estado, vence_at, hubspot_deal_id)
  select x.hubspot_task_id, x.telefono, x.tipo, 'abierta', x.vence_at, x.hubspot_deal_id
  from jsonb_to_recordset(coalesce(p -> 'tareas_nuevas', '[]'::jsonb)) as x(
    hubspot_task_id text, telefono text, tipo text, vence_at timestamptz, hubspot_deal_id text)
  on conflict (hubspot_task_id) do nothing;
  get diagnostics n_nuevas = row_count;

  update tareas t set
    estado        = coalesce(x.estado, t.estado),
    completada_at = case when x.estado = 'completada'
                         then coalesce(x.completada_at, t.completada_at, now())
                         else t.completada_at end,
    escalada_at   = coalesce(x.escalada_at, t.escalada_at)
  from jsonb_to_recordset(coalesce(p -> 'tareas_estado', '[]'::jsonb)) as x(
    hubspot_task_id text, estado text, completada_at timestamptz, escalada_at timestamptz)
  where t.hubspot_task_id = x.hubspot_task_id;
  get diagnostics n_estado = row_count;

  return jsonb_build_object('clientes', n_clientes, 'tareas_nuevas', n_nuevas, 'tareas_actualizadas', n_estado);
end $$;


-- ── F2: tomar clientes pendientes de análisis ───────────────────────────────
-- Elige hasta p_limite clientes con pendiente_analisis cuyo último mensaje tiene
-- al menos p_debounce_min minutos (debounce), los marca como tomados y devuelve
-- los últimos p_max_mensajes mensajes + tareas abiertas de cada uno.
create or replace function f2_tomar_pendientes(p_debounce_min int, p_limite int, p_max_mensajes int default 40)
returns table (
  telefono              text,
  nombre_wa             text,
  hubspot_deal_id       text,
  hubspot_contact_id    text,
  etapa                 text,
  vendedor_owner_id     text,
  vendedor_nombre       text,
  ultimo_msg_cliente_at timestamptz,
  ultimo_msg_empresa_at timestamptz,
  corte                 timestamptz,
  mensajes              jsonb,
  tareas_abiertas       jsonb
)
language plpgsql as $$
#variable_conflict use_column
begin
  return query
  with elegidos as (
    select c.telefono
    from clientes c
    where c.pendiente_analisis
      and c.hubspot_deal_id is not null
      and c.analisis_fallos < 5
      and greatest(c.ultimo_msg_cliente_at, c.ultimo_msg_empresa_at) <= now() - make_interval(mins => p_debounce_min)
      and (c.analisis_tomado_at is null or c.analisis_tomado_at < now() - interval '15 minutes')
    order by greatest(c.ultimo_msg_cliente_at, c.ultimo_msg_empresa_at)
    limit p_limite
    for update skip locked
  ),
  tomados as (
    update clientes c set
      analisis_tomado_at = now(),
      analisis_corte     = greatest(c.ultimo_msg_cliente_at, c.ultimo_msg_empresa_at)
    from elegidos e
    where c.telefono = e.telefono
    returning c.*
  )
  select t.telefono, t.nombre_wa, t.hubspot_deal_id, t.hubspot_contact_id, t.etapa,
         v.hubspot_owner_id, v.nombre,
         t.ultimo_msg_cliente_at, t.ultimo_msg_empresa_at, t.analisis_corte,
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'direccion', m.direccion, 'tipo', m.tipo, 'texto', m.texto, 'ts', m.ts)
                  order by m.ts, m.id), '[]'::jsonb)
          from (select m2.* from mensajes m2
                where m2.telefono = t.telefono
                order by m2.ts desc, m2.id desc
                limit p_max_mensajes) m),
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'hubspot_task_id', ta.hubspot_task_id, 'tipo', ta.tipo,
                    'vence_at', ta.vence_at, 'hubspot_deal_id', ta.hubspot_deal_id)), '[]'::jsonb)
          from tareas ta
          where ta.telefono = t.telefono and ta.estado = 'abierta')
  from tomados t
  left join vendedores v on v.id = t.vendedor_id;
end $$;


-- ── F2: guardar resultados ──────────────────────────────────────────────────
-- p = [{telefono, ok, corte, etapa?, hubspot_owner_id?, hubspot_deal_id?,
--       limpiar_deal?, tareas_nuevas: [...], analisis: {...}}]
-- ok=true  → pendiente_analisis queda en false, salvo que hayan llegado mensajes
--            después del corte (entonces se vuelve a analizar en la próxima corrida).
-- ok=false → queda pendiente; se reintenta cuando vence el candado (15 min).
-- liberar=true → no se alcanzó a analizar en esta corrida; se suelta el candado.
create or replace function f2_guardar_resultados(p jsonb)
returns jsonb
language plpgsql as $$
declare
  r     record;
  n_ok  int := 0;
  n_err int := 0;
begin
  for r in
    select * from jsonb_to_recordset(p) as x(
      telefono text, ok boolean, liberar boolean, corte timestamptz, etapa text, hubspot_owner_id text,
      hubspot_deal_id text, limpiar_deal boolean, tareas_nuevas jsonb, analisis jsonb)
  loop
    if coalesce(r.liberar, false) then
      update clientes c set analisis_tomado_at = null, analisis_corte = null where c.telefono = r.telefono;
      continue;
    end if;

    if r.analisis is not null then
      insert into analisis (telefono, hubspot_deal_id, modo, etapa_antes, etapa_detectada, confianza,
                            etapa_aplicada, resultado, decision, error, tokens)
      values (r.telefono, r.analisis ->> 'hubspot_deal_id', coalesce(r.analisis ->> 'modo', 'sombra'),
              r.analisis ->> 'etapa_antes', r.analisis ->> 'etapa_detectada',
              (r.analisis ->> 'confianza')::numeric, r.analisis ->> 'etapa_aplicada',
              r.analisis -> 'resultado', r.analisis -> 'decision', r.analisis ->> 'error',
              r.analisis -> 'tokens');
    end if;

    insert into tareas (hubspot_task_id, telefono, tipo, estado, vence_at, hubspot_deal_id)
    select x.hubspot_task_id, r.telefono, x.tipo, 'abierta', x.vence_at, x.hubspot_deal_id
    from jsonb_to_recordset(coalesce(r.tareas_nuevas, '[]'::jsonb)) as x(
      hubspot_task_id text, tipo text, vence_at timestamptz, hubspot_deal_id text)
    on conflict (hubspot_task_id) do nothing;

    if coalesce(r.ok, false) then
      update clientes c set
        -- Al milisegundo: el corte vuelve de n8n como JSON, sin microsegundos.
        pendiente_analisis = coalesce(date_trunc('milliseconds', greatest(c.ultimo_msg_cliente_at, c.ultimo_msg_empresa_at))
                                      > date_trunc('milliseconds', coalesce(r.corte, c.analisis_corte)), false),
        ultimo_analisis_at = now(),
        analisis_tomado_at = null,
        analisis_corte     = null,
        analisis_fallos    = 0,
        etapa              = coalesce(r.etapa, c.etapa),
        hubspot_deal_id    = case when coalesce(r.limpiar_deal, false) then null
                                  else coalesce(r.hubspot_deal_id, c.hubspot_deal_id) end,
        vendedor_id        = coalesce((select v.id from vendedores v where v.hubspot_owner_id = r.hubspot_owner_id),
                                      c.vendedor_id)
      where c.telefono = r.telefono;
      n_ok := n_ok + 1;
    else
      -- Si alcanzó a abrir un negocio nuevo antes de fallar, se guarda igual.
      update clientes c set
        analisis_fallos    = c.analisis_fallos + 1,
        analisis_tomado_at = now(),
        analisis_corte     = null,
        hubspot_deal_id    = coalesce(r.hubspot_deal_id, c.hubspot_deal_id),
        etapa              = coalesce(r.etapa, c.etapa)
      where c.telefono = r.telefono;
      n_err := n_err + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', n_ok, 'errores', n_err);
end $$;


-- ── F3: clientes sin respuesta y tareas "contestar" abiertas ────────────────
create or replace function f3_estado()
returns table (
  telefono              text,
  nombre_wa             text,
  hubspot_deal_id       text,
  hubspot_contact_id    text,
  etapa                 text,
  vendedor_owner_id     text,
  vendedor_nombre       text,
  ultimo_msg_cliente_at timestamptz,
  ultimo_msg_empresa_at timestamptz,
  sin_respuesta         boolean,
  tareas_contestar      jsonb
)
language sql stable as $$
  select c.telefono, c.nombre_wa, c.hubspot_deal_id, c.hubspot_contact_id, c.etapa,
         v.hubspot_owner_id, v.nombre,
         c.ultimo_msg_cliente_at, c.ultimo_msg_empresa_at,
         coalesce(c.ultimo_msg_cliente_at > coalesce(c.ultimo_msg_empresa_at, '-infinity'::timestamptz), false),
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'hubspot_task_id', t.hubspot_task_id, 'vence_at', t.vence_at,
                    'creada_at', t.creada_at, 'escalada_at', t.escalada_at)
                  order by t.creada_at), '[]'::jsonb)
          from tareas t
          where t.telefono = c.telefono and t.tipo = 'contestar' and t.estado = 'abierta')
  from clientes c
  left join vendedores v on v.id = c.vendedor_id
  where c.hubspot_deal_id is not null
    and (c.ultimo_msg_cliente_at > coalesce(c.ultimo_msg_empresa_at, '-infinity'::timestamptz)
         or exists (select 1 from tareas t
                    where t.telefono = c.telefono and t.tipo = 'contestar' and t.estado = 'abierta'))
$$;


-- ── F4: tareas abiertas para revisar en HubSpot ─────────────────────────────
create or replace function f4_tareas_abiertas()
returns table (
  hubspot_task_id    text,
  tipo               text,
  telefono           text,
  tarea_deal_id      text,
  nombre_wa          text,
  hubspot_contact_id text,
  hubspot_deal_id    text,
  etapa              text,
  vendedor_owner_id  text
)
language sql stable as $$
  select t.hubspot_task_id, t.tipo, t.telefono, t.hubspot_deal_id,
         c.nombre_wa, c.hubspot_contact_id, c.hubspot_deal_id, c.etapa,
         v.hubspot_owner_id
  from tareas t
  join clientes c on c.telefono = t.telefono
  left join vendedores v on v.id = c.vendedor_id
  where t.estado = 'abierta'
  order by t.creada_at
$$;


-- ── F5: datos de Postgres para el resumen diario ────────────────────────────
create or replace function f5_datos()
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'sin_responder', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'telefono', c.telefono, 'nombre', c.nombre_wa, 'etapa', c.etapa,
               'vendedor', v.nombre, 'desde', c.ultimo_msg_cliente_at)
             order by c.ultimo_msg_cliente_at), '[]'::jsonb)
      from clientes c
      left join vendedores v on v.id = c.vendedor_id
      where c.hubspot_deal_id is not null
        and c.etapa <> 'perdido'
        and c.ultimo_msg_cliente_at > coalesce(c.ultimo_msg_empresa_at, '-infinity'::timestamptz)),
    'tareas_vencidas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo, 'vence_at', t.vence_at,
               'telefono', c.telefono, 'nombre', c.nombre_wa, 'vendedor', v.nombre)
             order by v.nombre, t.vence_at), '[]'::jsonb)
      from tareas t
      join clientes c on c.telefono = t.telefono
      left join vendedores v on v.id = c.vendedor_id
      where t.estado = 'abierta' and t.vence_at < now()),
    'analisis_con_error_24h', (
      select count(*) from analisis a
      where a.error is not null and a.creado_at > now() - interval '24 hours'),
    'clientes_sin_analizar', (
      select count(*) from clientes c
      where c.pendiente_analisis and c.hubspot_deal_id is not null and c.analisis_fallos >= 5)
  )
$$;
$m_002_implementacion_sql$;
    insert into merch.schema_migraciones (version) values ('002_implementacion.sql');
  end if;
end $migracion$;

-- 003_resumen_por_vendedor.sql
do $migracion$
begin
  if not exists (select 1 from merch.schema_migraciones where version = '003_resumen_por_vendedor.sql') then
    execute $m_003_resumen_por_vendedor_sql$
-- 003 — Resumen diario por vendedor.
-- f5_datos() agrega el hubspot_owner_id del vendedor a cada fila, las tareas
-- abiertas con fecha límite y la lista de vendedores disponibles, para que F5
-- mande a cada uno sus propios pendientes.

create or replace function f5_datos()
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'sin_responder', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'telefono', c.telefono, 'nombre', c.nombre_wa, 'etapa', c.etapa,
               'vendedor', v.nombre, 'vendedor_owner_id', v.hubspot_owner_id,
               'desde', c.ultimo_msg_cliente_at)
             order by c.ultimo_msg_cliente_at), '[]'::jsonb)
      from clientes c
      left join vendedores v on v.id = c.vendedor_id
      where c.hubspot_deal_id is not null
        and c.etapa <> 'perdido'
        and c.ultimo_msg_cliente_at > coalesce(c.ultimo_msg_empresa_at, '-infinity'::timestamptz)),
    'tareas_vencidas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo, 'vence_at', t.vence_at,
               'telefono', c.telefono, 'nombre', c.nombre_wa,
               'vendedor', v.nombre, 'vendedor_owner_id', v.hubspot_owner_id)
             order by v.nombre, t.vence_at), '[]'::jsonb)
      from tareas t
      join clientes c on c.telefono = t.telefono
      left join vendedores v on v.id = c.vendedor_id
      where t.estado = 'abierta' and t.vence_at < now()),
    'tareas_abiertas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo, 'vence_at', t.vence_at,
               'telefono', c.telefono, 'nombre', c.nombre_wa,
               'vendedor', v.nombre, 'vendedor_owner_id', v.hubspot_owner_id)
             order by t.vence_at), '[]'::jsonb)
      from tareas t
      join clientes c on c.telefono = t.telefono
      left join vendedores v on v.id = c.vendedor_id
      where t.estado = 'abierta' and t.vence_at is not null),
    'vendedores', (
      select coalesce(jsonb_agg(jsonb_build_object('nombre', v.nombre, 'hubspot_owner_id', v.hubspot_owner_id)
             order by v.orden, v.id), '[]'::jsonb)
      from vendedores v
      where v.disponible),
    'analisis_con_error_24h', (
      select count(*) from analisis a
      where a.error is not null and a.creado_at > now() - interval '24 hours'),
    'clientes_sin_analizar', (
      select count(*) from clientes c
      where c.pendiente_analisis and c.hubspot_deal_id is not null and c.analisis_fallos >= 5)
  )
$$;
$m_003_resumen_por_vendedor_sql$;
    insert into merch.schema_migraciones (version) values ('003_resumen_por_vendedor.sql');
  end if;
end $migracion$;

-- 004_tarea_propietario.sql
do $migracion$
begin
  if not exists (select 1 from merch.schema_migraciones where version = '004_tarea_propietario.sql') then
    execute $m_004_tarea_propietario_sql$
-- 004 — A quién está asignada cada tarea.
-- La tarea "Iniciar producción" puede ir a una persona fija
-- (PRODUCCION_HUBSPOT_OWNER_ID) en lugar del vendedor del cliente. Se guarda el
-- propietario de cada tarea para que el resumen diario se la muestre a quien
-- la tiene. Las tareas sin propietario guardado siguen contando para el
-- vendedor del cliente.

alter table tareas
  add column hubspot_owner_id text;                      -- propietario de la tarea en HubSpot (null = el vendedor del cliente)

create or replace function registrar_cambios(p jsonb)
returns jsonb
language plpgsql as $$
declare
  n_clientes int;
  n_nuevas   int;
  n_estado   int;
begin
  update clientes c set
    hubspot_contact_id = coalesce(x.hubspot_contact_id, c.hubspot_contact_id),
    hubspot_deal_id    = case when coalesce(x.limpiar_deal, false) then null
                              else coalesce(x.hubspot_deal_id, c.hubspot_deal_id) end,
    etapa              = coalesce(x.etapa, c.etapa),
    vendedor_id        = coalesce((select v.id from vendedores v where v.hubspot_owner_id = x.hubspot_owner_id),
                                  c.vendedor_id),
    alta_intentada_at  = case when coalesce(x.alta_completa, false) then null else c.alta_intentada_at end
  from jsonb_to_recordset(coalesce(p -> 'clientes', '[]'::jsonb)) as x(
    telefono text, hubspot_contact_id text, hubspot_deal_id text, etapa text,
    hubspot_owner_id text, alta_completa boolean, limpiar_deal boolean)
  where c.telefono = x.telefono;
  get diagnostics n_clientes = row_count;

  insert into tareas (hubspot_task_id, telefono, tipo, estado, vence_at, hubspot_deal_id, hubspot_owner_id)
  select x.hubspot_task_id, x.telefono, x.tipo, 'abierta', x.vence_at, x.hubspot_deal_id, x.hubspot_owner_id
  from jsonb_to_recordset(coalesce(p -> 'tareas_nuevas', '[]'::jsonb)) as x(
    hubspot_task_id text, telefono text, tipo text, vence_at timestamptz, hubspot_deal_id text, hubspot_owner_id text)
  on conflict (hubspot_task_id) do nothing;
  get diagnostics n_nuevas = row_count;

  update tareas t set
    estado        = coalesce(x.estado, t.estado),
    completada_at = case when x.estado = 'completada'
                         then coalesce(x.completada_at, t.completada_at, now())
                         else t.completada_at end,
    escalada_at   = coalesce(x.escalada_at, t.escalada_at)
  from jsonb_to_recordset(coalesce(p -> 'tareas_estado', '[]'::jsonb)) as x(
    hubspot_task_id text, estado text, completada_at timestamptz, escalada_at timestamptz)
  where t.hubspot_task_id = x.hubspot_task_id;
  get diagnostics n_estado = row_count;

  return jsonb_build_object('clientes', n_clientes, 'tareas_nuevas', n_nuevas, 'tareas_actualizadas', n_estado);
end $$;

-- Igual que en 003, pero cada tarea cuenta para su propietario (si se guardó).
create or replace function f5_datos()
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'sin_responder', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'telefono', c.telefono, 'nombre', c.nombre_wa, 'etapa', c.etapa,
               'vendedor', v.nombre, 'vendedor_owner_id', v.hubspot_owner_id,
               'desde', c.ultimo_msg_cliente_at)
             order by c.ultimo_msg_cliente_at), '[]'::jsonb)
      from clientes c
      left join vendedores v on v.id = c.vendedor_id
      where c.hubspot_deal_id is not null
        and c.etapa <> 'perdido'
        and c.ultimo_msg_cliente_at > coalesce(c.ultimo_msg_empresa_at, '-infinity'::timestamptz)),
    'tareas_vencidas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo, 'vence_at', t.vence_at,
               'telefono', c.telefono, 'nombre', c.nombre_wa,
               'vendedor', coalesce(vt.nombre, v.nombre),
               'vendedor_owner_id', coalesce(t.hubspot_owner_id, v.hubspot_owner_id))
             order by coalesce(vt.nombre, v.nombre), t.vence_at), '[]'::jsonb)
      from tareas t
      join clientes c on c.telefono = t.telefono
      left join vendedores v on v.id = c.vendedor_id
      left join vendedores vt on vt.hubspot_owner_id = t.hubspot_owner_id
      where t.estado = 'abierta' and t.vence_at < now()),
    'tareas_abiertas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo, 'vence_at', t.vence_at,
               'telefono', c.telefono, 'nombre', c.nombre_wa,
               'vendedor', coalesce(vt.nombre, v.nombre),
               'vendedor_owner_id', coalesce(t.hubspot_owner_id, v.hubspot_owner_id))
             order by t.vence_at), '[]'::jsonb)
      from tareas t
      join clientes c on c.telefono = t.telefono
      left join vendedores v on v.id = c.vendedor_id
      left join vendedores vt on vt.hubspot_owner_id = t.hubspot_owner_id
      where t.estado = 'abierta' and t.vence_at is not null),
    'vendedores', (
      select coalesce(jsonb_agg(jsonb_build_object('nombre', v.nombre, 'hubspot_owner_id', v.hubspot_owner_id)
             order by v.orden, v.id), '[]'::jsonb)
      from vendedores v
      where v.disponible),
    'analisis_con_error_24h', (
      select count(*) from analisis a
      where a.error is not null and a.creado_at > now() - interval '24 hours'),
    'clientes_sin_analizar', (
      select count(*) from clientes c
      where c.pendiente_analisis and c.hubspot_deal_id is not null and c.analisis_fallos >= 5)
  )
$$;
$m_004_tarea_propietario_sql$;
    insert into merch.schema_migraciones (version) values ('004_tarea_propietario.sql');
  end if;
end $migracion$;

-- 005_traspasos.sql
do $migracion$
begin
  if not exists (select 1 from merch.schema_migraciones where version = '005_traspasos.sql') then
    execute $m_005_traspasos_sql$
-- 005 — Traspasos de clientes entre vendedores.
-- Cuando alguien cambia en HubSpot el propietario de un negocio, F4 lo detecta
-- comparándolo con el último propietario visto, pasa las tareas pendientes al
-- nuevo vendedor, le avisa y deja el traspaso registrado aquí.

alter table clientes
  add column hubspot_owner_visto text;                   -- último propietario del negocio visto por la revisión de traspasos

create table traspasos (
  id              bigserial primary key,
  telefono        text not null references clientes(telefono),
  hubspot_deal_id text,
  de_owner_id     text,
  a_owner_id      text not null,
  de_nombre       text,
  a_nombre        text,
  tareas_movidas  int not null default 0,
  creado_at       timestamptz not null default now()
);
create index on traspasos (creado_at);

-- Igual que en 004, más:
--   clientes.hubspot_owner_visto: lo fija la revisión de traspasos, o el alta
--     (el propietario con el que el sistema crea el negocio no es un traspaso);
--   tareas_estado.hubspot_owner_id: tareas que pasan a otro propietario;
--   traspasos: registro de cada traspaso detectado.
create or replace function registrar_cambios(p jsonb)
returns jsonb
language plpgsql as $$
declare
  n_clientes  int;
  n_nuevas    int;
  n_estado    int;
  n_traspasos int;
begin
  update clientes c set
    hubspot_contact_id  = coalesce(x.hubspot_contact_id, c.hubspot_contact_id),
    hubspot_deal_id     = case when coalesce(x.limpiar_deal, false) then null
                               else coalesce(x.hubspot_deal_id, c.hubspot_deal_id) end,
    etapa               = coalesce(x.etapa, c.etapa),
    vendedor_id         = coalesce((select v.id from vendedores v where v.hubspot_owner_id = x.hubspot_owner_id),
                                   c.vendedor_id),
    alta_intentada_at   = case when coalesce(x.alta_completa, false) then null else c.alta_intentada_at end,
    hubspot_owner_visto = coalesce(x.hubspot_owner_visto,
                                   case when coalesce(x.alta_completa, false) then x.hubspot_owner_id end,
                                   c.hubspot_owner_visto)
  from jsonb_to_recordset(coalesce(p -> 'clientes', '[]'::jsonb)) as x(
    telefono text, hubspot_contact_id text, hubspot_deal_id text, etapa text,
    hubspot_owner_id text, alta_completa boolean, limpiar_deal boolean, hubspot_owner_visto text)
  where c.telefono = x.telefono;
  get diagnostics n_clientes = row_count;

  insert into tareas (hubspot_task_id, telefono, tipo, estado, vence_at, hubspot_deal_id, hubspot_owner_id)
  select x.hubspot_task_id, x.telefono, x.tipo, 'abierta', x.vence_at, x.hubspot_deal_id, x.hubspot_owner_id
  from jsonb_to_recordset(coalesce(p -> 'tareas_nuevas', '[]'::jsonb)) as x(
    hubspot_task_id text, telefono text, tipo text, vence_at timestamptz, hubspot_deal_id text, hubspot_owner_id text)
  on conflict (hubspot_task_id) do nothing;
  get diagnostics n_nuevas = row_count;

  update tareas t set
    estado           = coalesce(x.estado, t.estado),
    completada_at    = case when x.estado = 'completada'
                            then coalesce(x.completada_at, t.completada_at, now())
                            else t.completada_at end,
    escalada_at      = coalesce(x.escalada_at, t.escalada_at),
    hubspot_owner_id = coalesce(x.hubspot_owner_id, t.hubspot_owner_id)
  from jsonb_to_recordset(coalesce(p -> 'tareas_estado', '[]'::jsonb)) as x(
    hubspot_task_id text, estado text, completada_at timestamptz, escalada_at timestamptz, hubspot_owner_id text)
  where t.hubspot_task_id = x.hubspot_task_id;
  get diagnostics n_estado = row_count;

  insert into traspasos (telefono, hubspot_deal_id, de_owner_id, a_owner_id, de_nombre, a_nombre, tareas_movidas)
  select x.telefono, x.hubspot_deal_id, x.de_owner_id, x.a_owner_id, x.de_nombre, x.a_nombre, coalesce(x.tareas_movidas, 0)
  from jsonb_to_recordset(coalesce(p -> 'traspasos', '[]'::jsonb)) as x(
    telefono text, hubspot_deal_id text, de_owner_id text, a_owner_id text, de_nombre text, a_nombre text, tareas_movidas int)
  where exists (select 1 from clientes c where c.telefono = x.telefono);
  get diagnostics n_traspasos = row_count;

  return jsonb_build_object('clientes', n_clientes, 'tareas_nuevas', n_nuevas, 'tareas_actualizadas', n_estado,
                            'traspasos', n_traspasos);
end $$;

-- ── F4: clientes con negocio abierto, para revisar traspasos ────────────────
create or replace function f4_clientes_abiertos()
returns table (
  telefono            text,
  nombre_wa           text,
  hubspot_deal_id     text,
  hubspot_contact_id  text,
  hubspot_owner_visto text,
  tareas_abiertas     jsonb
)
language sql stable as $$
  select c.telefono, c.nombre_wa, c.hubspot_deal_id, c.hubspot_contact_id, c.hubspot_owner_visto,
         coalesce((select jsonb_agg(jsonb_build_object('hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo)
                                    order by t.creada_at)
                   from tareas t
                   where t.telefono = c.telefono and t.estado = 'abierta'), '[]'::jsonb)
  from clientes c
  where c.hubspot_deal_id is not null
    and c.etapa not in ('entregado', 'perdido')
  order by c.telefono
$$;

-- Igual que en 004, más los traspasos de las últimas 24 h.
create or replace function f5_datos()
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'sin_responder', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'telefono', c.telefono, 'nombre', c.nombre_wa, 'etapa', c.etapa,
               'vendedor', v.nombre, 'vendedor_owner_id', v.hubspot_owner_id,
               'desde', c.ultimo_msg_cliente_at)
             order by c.ultimo_msg_cliente_at), '[]'::jsonb)
      from clientes c
      left join vendedores v on v.id = c.vendedor_id
      where c.hubspot_deal_id is not null
        and c.etapa <> 'perdido'
        and c.ultimo_msg_cliente_at > coalesce(c.ultimo_msg_empresa_at, '-infinity'::timestamptz)),
    'tareas_vencidas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo, 'vence_at', t.vence_at,
               'telefono', c.telefono, 'nombre', c.nombre_wa,
               'vendedor', coalesce(vt.nombre, v.nombre),
               'vendedor_owner_id', coalesce(t.hubspot_owner_id, v.hubspot_owner_id))
             order by coalesce(vt.nombre, v.nombre), t.vence_at), '[]'::jsonb)
      from tareas t
      join clientes c on c.telefono = t.telefono
      left join vendedores v on v.id = c.vendedor_id
      left join vendedores vt on vt.hubspot_owner_id = t.hubspot_owner_id
      where t.estado = 'abierta' and t.vence_at < now()),
    'tareas_abiertas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'hubspot_task_id', t.hubspot_task_id, 'tipo', t.tipo, 'vence_at', t.vence_at,
               'telefono', c.telefono, 'nombre', c.nombre_wa,
               'vendedor', coalesce(vt.nombre, v.nombre),
               'vendedor_owner_id', coalesce(t.hubspot_owner_id, v.hubspot_owner_id))
             order by t.vence_at), '[]'::jsonb)
      from tareas t
      join clientes c on c.telefono = t.telefono
      left join vendedores v on v.id = c.vendedor_id
      left join vendedores vt on vt.hubspot_owner_id = t.hubspot_owner_id
      where t.estado = 'abierta' and t.vence_at is not null),
    'traspasos', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'telefono', tr.telefono, 'nombre', c.nombre_wa,
               'de', tr.de_nombre, 'a', tr.a_nombre,
               'tareas_movidas', tr.tareas_movidas, 'cuando', tr.creado_at)
             order by tr.creado_at), '[]'::jsonb)
      from traspasos tr
      join clientes c on c.telefono = tr.telefono
      where tr.creado_at > now() - interval '24 hours'),
    'vendedores', (
      select coalesce(jsonb_agg(jsonb_build_object('nombre', v.nombre, 'hubspot_owner_id', v.hubspot_owner_id)
             order by v.orden, v.id), '[]'::jsonb)
      from vendedores v
      where v.disponible),
    'analisis_con_error_24h', (
      select count(*) from analisis a
      where a.error is not null and a.creado_at > now() - interval '24 hours'),
    'clientes_sin_analizar', (
      select count(*) from clientes c
      where c.pendiente_analisis and c.hubspot_deal_id is not null and c.analisis_fallos >= 5)
  )
$$;
$m_005_traspasos_sql$;
    insert into merch.schema_migraciones (version) values ('005_traspasos.sql');
  end if;
end $migracion$;

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

select 'Instalación lista' as resultado, (select count(*) from merch.schema_migraciones) as migraciones;
