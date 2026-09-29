#!/usr/bin/env node
'use strict';

// Genera los dos archivos que se pegan en el panel de Supabase:
//   supabase/instalar.sql                 → SQL Editor
//   supabase/functions/merch/index.ts     → Edge Function "merch"
// a partir de db/migraciones, supabase/sql y src/.
//
// Uso: node supabase/construir.js

const fs = require('fs');
const path = require('path');
const { empaquetar } = require('../scripts/empaquetar');

const RAIZ = path.join(__dirname, '..');
const ESQUEMA = 'merch';

function leer(...partes) {
  return fs.readFileSync(path.join(RAIZ, ...partes), 'utf8');
}

// Cada migración se aplica una sola vez, igual que scripts/migrar.js, así el
// archivo se puede volver a correr completo cuando haya migraciones nuevas.
function migracion(archivo) {
  const sql = leer('db', 'migraciones', archivo);
  const etiqueta = `$m_${archivo.replace(/\W/g, '_')}$`;
  if (sql.includes(etiqueta)) throw new Error(`${archivo} contiene ${etiqueta}`);
  return [
    `-- ${archivo}`,
    'do $migracion$',
    'begin',
    `  if not exists (select 1 from ${ESQUEMA}.schema_migraciones where version = '${archivo}') then`,
    `    execute ${etiqueta}`,
    sql.trim(),
    `${etiqueta};`,
    `    insert into ${ESQUEMA}.schema_migraciones (version) values ('${archivo}');`,
    '  end if;',
    'end $migracion$;',
  ].join('\n');
}

function construirSql() {
  const migraciones = fs.readdirSync(path.join(RAIZ, 'db', 'migraciones')).filter((f) => f.endsWith('.sql')).sort();
  return [
    '-- Merch Caracas · instalación en Supabase',
    '-- Generado por supabase/construir.js. Pégalo completo en el SQL Editor de tu',
    '-- proyecto y ejecútalo. Se puede volver a correr: no borra ni duplica nada.',
    '',
    `create schema if not exists ${ESQUEMA};`,
    `set search_path = ${ESQUEMA}, public;`,
    '',
    'create table if not exists schema_migraciones (',
    '  version     text primary key,',
    '  aplicada_at timestamptz not null default now()',
    ');',
    '',
    ...migraciones.map(migracion).flatMap((m) => [m, '']),
    leer('supabase', 'sql', 'supabase.sql').trim(),
    '',
    "select 'Instalación lista' as resultado, (select count(*) from merch.schema_migraciones) as migraciones;",
    '',
  ].join('\n');
}

function construirFuncion() {
  return [
    '// @ts-nocheck',
    '// Edge Function "merch" de Merch Caracas.',
    '// Generada por supabase/construir.js desde src/. No la edites aquí: cambia',
    '// src/, corre `node supabase/construir.js` y vuelve a pegarla en Supabase.',
    '',
    "import postgres from 'npm:postgres@3.4.5';",
    '',
    empaquetar(['src/supabase.js', 'src/http.js']),
    '',
    "const sql = postgres(Deno.env.get('SUPABASE_DB_URL'), { prepare: false, max: 3, idle_timeout: 20 });",
    "const { crearHttp } = __cargar('src/http.js');",
    '',
    "Deno.serve(__cargar('src/supabase.js').crearManejador({",
    '  consultar: (texto, parametros = []) => sql.unsafe(texto, parametros),',
    '  envBase: Deno.env.toObject(),',
    '  // Cada llamada externa espera como máximo 60 s: la función corta a los 150 s.',
    '  http: crearHttp({ maxTimeoutMs: 60000 }),',
    "  enSegundoPlano: (promesa) => (typeof EdgeRuntime !== 'undefined' ? EdgeRuntime.waitUntil(promesa) : promesa),",
    '  esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),',
    '}));',
    '',
  ].join('\n');
}

function main() {
  const sql = path.join(__dirname, 'instalar.sql');
  const funcion = path.join(__dirname, 'functions', 'merch', 'index.ts');
  fs.mkdirSync(path.dirname(funcion), { recursive: true });
  fs.writeFileSync(sql, construirSql());
  fs.writeFileSync(funcion, construirFuncion());
  console.log(`✔ ${path.relative(RAIZ, sql)}`);
  console.log(`✔ ${path.relative(RAIZ, funcion)}`);
}

if (require.main === module) main();

module.exports = { construirSql, construirFuncion };
