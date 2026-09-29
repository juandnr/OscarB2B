#!/usr/bin/env node
'use strict';

// Aplica en orden las migraciones de db/migraciones/ que falten.
// Uso: DATABASE_URL=postgres://... node scripts/migrar.js

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { cargarEnv } = require('./lib');

const CARPETA = path.join(__dirname, '..', 'db', 'migraciones');

async function migrar(connectionString) {
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query(`create table if not exists schema_migraciones (
      version text primary key,
      aplicada_at timestamptz not null default now()
    )`);
    const hechas = new Set((await db.query('select version from schema_migraciones')).rows.map((r) => r.version));
    const archivos = fs.readdirSync(CARPETA).filter((f) => f.endsWith('.sql')).sort();
    for (const archivo of archivos) {
      if (hechas.has(archivo)) continue;
      const sql = fs.readFileSync(path.join(CARPETA, archivo), 'utf8');
      await db.query('begin');
      try {
        await db.query(sql);
        await db.query('insert into schema_migraciones (version) values ($1)', [archivo]);
        await db.query('commit');
        console.log(`✔ ${archivo}`);
      } catch (error) {
        await db.query('rollback');
        throw new Error(`${archivo}: ${error.message}`);
      }
    }
    console.log('Migraciones al día.');
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  cargarEnv();
  if (!process.env.DATABASE_URL) {
    console.error('✘ Falta DATABASE_URL');
    process.exit(1);
  }
  migrar(process.env.DATABASE_URL).catch((error) => {
    console.error(`✘ ${error.message}`);
    process.exit(1);
  });
}

module.exports = { migrar };
