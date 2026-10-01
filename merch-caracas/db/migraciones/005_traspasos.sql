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
