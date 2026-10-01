-- 006 — Canal de correo (Gmail).
-- Un script de Google Apps Script en la cuenta de Gmail de la empresa manda
-- cada pocos minutos los correos nuevos (recibidos y enviados). Se guardan aquí
-- y F6 decide cuáles son de clientes. Los clientes de correo usan como clave
-- 'correo:<email>' en clientes.telefono, así F2–F5 los tratan igual que a los
-- de WhatsApp.

create table correos (
  id            text primary key,                  -- id del mensaje en Gmail
  hilo          text,                              -- id del hilo en Gmail
  direccion     text not null check (direccion in ('entrante', 'saliente')),
  de_email      text not null,
  de_nombre     text,
  destinatarios text[] not null default '{}',      -- para + cc, en minúsculas
  asunto        text,
  texto         text,                              -- cuerpo sin las citas de correos anteriores
  fecha         timestamptz not null,
  etiquetas     text[] not null default '{}',      -- etiquetas de Gmail (INBOX, SENT, CATEGORY_...)
  cabeceras     jsonb not null default '{}',       -- list_unsubscribe, precedence, auto_submitted
  estado        text not null default 'pendiente'
                check (estado in ('pendiente', 'cliente', 'no_cliente', 'ignorado')),
  motivo        text,                              -- por qué se decidió el estado
  cliente       text references clientes(telefono),-- cliente al que se le registró el correo
  tomado_at     timestamptz,                       -- candado de F6 mientras lo procesa
  intentos      int not null default 0,
  creado_at     timestamptz not null default now()
);
create index correos_pendientes_idx on correos (fecha) where estado = 'pendiente';
create index correos_remitente_idx on correos (de_email, creado_at);

-- ── F6: guardar los correos que manda Gmail ─────────────────────────────────
-- [{id, hilo, direccion, de_email, de_nombre, destinatarios, asunto, texto,
--   fecha, etiquetas, cabeceras}] → cantidad de correos nuevos.
create or replace function f6_guardar_correos(p jsonb)
returns int
language plpgsql as $$
declare
  n int;
begin
  insert into correos (id, hilo, direccion, de_email, de_nombre, destinatarios, asunto, texto, fecha, etiquetas, cabeceras)
  select x.id, x.hilo, x.direccion, lower(x.de_email), x.de_nombre,
         coalesce(array(select lower(d) from jsonb_array_elements_text(coalesce(x.destinatarios, '[]'::jsonb)) as d), '{}'),
         x.asunto, x.texto, x.fecha,
         coalesce(array(select e from jsonb_array_elements_text(coalesce(x.etiquetas, '[]'::jsonb)) as e), '{}'),
         coalesce(x.cabeceras, '{}'::jsonb)
  from jsonb_to_recordset(p) as x(
    id text, hilo text, direccion text, de_email text, de_nombre text, destinatarios jsonb,
    asunto text, texto text, fecha timestamptz, etiquetas jsonb, cabeceras jsonb)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── F6: tomar correos pendientes ────────────────────────────────────────────
-- Los marca como tomados (candado de 10 min) y agrega lo que se sabe de cada uno:
--   cliente_existente: clave del cliente si el remitente (entrante) ya es cliente;
--   clientes_destino:  claves de los clientes a los que va dirigido (saliente);
--   remitente_descartado: el remitente se clasificó como no cliente en los
--                         últimos 30 días (no se vuelve a consultar a Claude).
create or replace function f6_tomar_correos(p_limite int)
returns table (
  id                   text,
  direccion            text,
  de_email             text,
  de_nombre            text,
  destinatarios        text[],
  asunto               text,
  texto                text,
  fecha                timestamptz,
  etiquetas            text[],
  cabeceras            jsonb,
  cliente_existente    text,
  clientes_destino     text[],
  remitente_descartado boolean
)
language plpgsql as $$
#variable_conflict use_column
begin
  return query
  with elegidos as (
    select c.id
    from correos c
    where c.estado = 'pendiente'
      and c.intentos < 5
      and (c.tomado_at is null or c.tomado_at < now() - interval '10 minutes')
    order by c.fecha
    limit p_limite
    for update skip locked
  ),
  tomados as (
    update correos c set tomado_at = now(), intentos = c.intentos + 1
    from elegidos e
    where c.id = e.id
    returning c.*
  )
  select t.id, t.direccion, t.de_email, t.de_nombre, t.destinatarios, t.asunto, t.texto, t.fecha,
         t.etiquetas, t.cabeceras,
         (select cl.telefono from clientes cl where cl.telefono = 'correo:' || t.de_email),
         array(select cl.telefono from clientes cl
               where cl.telefono = any (array(select 'correo:' || d from unnest(t.destinatarios) as d))
               order by cl.telefono),
         exists (select 1 from correos o
                 where o.de_email = t.de_email and o.estado = 'no_cliente'
                   and o.id <> t.id and o.creado_at > now() - interval '30 days')
  from tomados t
  order by t.fecha;
end $$;

-- ── F6: guardar la decisión y registrar los correos de clientes ─────────────
-- p = { correos: [{id, estado, motivo, cliente}], liberar: [id], mensajes: [...] }
--   correos:  decisión sobre cada correo (estado final);
--   liberar:  correos que no se pudieron decidir (vuelven a quedar pendientes);
--   mensajes: correos de clientes con el formato de f1_registrar_mensajes.
-- Devuelve lo mismo que f1_registrar_mensajes (alta y tareas respondidas).
create or replace function f6_guardar_resultados(p jsonb)
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
begin
  -- Primero los mensajes: crea los clientes nuevos, que correos.cliente referencia.
  -- (return query agrega las filas al resultado y la función sigue.)
  return query select * from f1_registrar_mensajes(coalesce(p -> 'mensajes', '[]'::jsonb));

  update correos c set
    estado    = x.estado,
    motivo    = x.motivo,
    cliente   = x.cliente,
    tomado_at = null
  from jsonb_to_recordset(coalesce(p -> 'correos', '[]'::jsonb)) as x(id text, estado text, motivo text, cliente text)
  where c.id = x.id;

  update correos c set tomado_at = null
  where c.id in (select jsonb_array_elements_text(coalesce(p -> 'liberar', '[]'::jsonb)));
end $$;
