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
