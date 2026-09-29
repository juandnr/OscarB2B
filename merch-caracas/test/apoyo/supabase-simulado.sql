-- Imitación mínima de Vault, pg_cron y pg_net de Supabase para las pruebas
-- locales (misma forma de llamada, sin cifrado ni HTTP real).
create schema if not exists vault;
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  secret text not null
);
create or replace view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as $$
  insert into vault.secrets (name, secret) values (new_name, new_secret) returning id
$$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name) where id = secret_id
$$;

create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create table if not exists cron.job_run_details (runid bigserial primary key, end_time timestamptz);
create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;

create schema if not exists net;
create table if not exists net.solicitudes (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                         headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language sql as $$
  insert into net.solicitudes (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id
$$;
