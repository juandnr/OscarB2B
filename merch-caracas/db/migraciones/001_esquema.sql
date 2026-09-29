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
