#!/usr/bin/env node
'use strict';

// Revisa que todo esté listo antes de activar los flujos: variables de entorno,
// base de datos, vendedores, HubSpot (pipeline y etapas) y API de Claude.
// Uso: node scripts/verificar.js   (lee .env si existe)

const { Client } = require('pg');
const { cargarEnv, http } = require('./lib');
const { leerConfig } = require('../src/config');
const { parsearHorario, enHorarioLaboral } = require('../src/horario');
const { crearHubSpot } = require('../src/hubspot');
const { ETAPAS } = require('../src/etapas');

let fallas = 0;
const ok = (m) => console.log(`✔ ${m}`);
const mal = (m) => {
  fallas += 1;
  console.log(`✘ ${m}`);
};
const aviso = (m) => console.log(`! ${m}`);

async function main() {
  cargarEnv();
  const config = leerConfig(process.env);

  // Horario laboral
  if (!config.horarioLaboral) {
    mal('HORARIO_LABORAL no está definido (pendiente de Oscar). F1 y F3 lo necesitan.');
  } else {
    try {
      const cal = parsearHorario(config.horarioLaboral, config.feriados);
      ok(`HORARIO_LABORAL válido. Ahora mismo ${enHorarioLaboral(new Date(), cal, config.timezone) ? '' : 'no '}es horario laboral en ${config.timezone}.`);
    } catch (error) {
      mal(error.message);
    }
  }
  if (!config.d360.webhookSecret) mal('Falta D360_WEBHOOK_SECRET');
  else if (config.d360.webhookSecret.length < 24) aviso('D360_WEBHOOK_SECRET es corto: usa al menos 24 caracteres al azar.');
  if (!config.hubspot.adminOwnerId) mal('Falta ADMIN_HUBSPOT_OWNER_ID (escalamientos y resumen diario).');
  console.log(`• F2 en modo ${config.modoSombra ? 'SOMBRA (solo resumen_ia + nota)' : 'ACTIVO (mueve etapas y crea tareas)'}`);

  // Postgres
  let owners = [];
  if (!process.env.DATABASE_URL) {
    mal('Falta DATABASE_URL');
  } else {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await db.connect();
      const migraciones = (await db.query('select version from schema_migraciones order by 1')).rows.map((r) => r.version);
      ok(`Postgres conectado. Migraciones: ${migraciones.join(', ')}`);
      const vendedores = (await db.query('select nombre, hubspot_owner_id, disponible, orden from vendedores order by orden')).rows;
      if (!vendedores.length) mal('La tabla vendedores está vacía (ver db/vendedores.ejemplo.sql).');
      else if (!vendedores.some((v) => v.disponible)) mal('Ningún vendedor está disponible: la rotación no puede asignar.');
      else ok(`Vendedores: ${vendedores.map((v) => `${v.orden}. ${v.nombre}${v.disponible ? '' : ' (no disponible)'}`).join(', ')}`);
      owners = vendedores.map((v) => v.hubspot_owner_id);
    } catch (error) {
      mal(`Postgres: ${error.message}`);
    } finally {
      await db.end().catch(() => {});
    }
  }

  // HubSpot
  if (!config.hubspot.token) {
    mal('Falta HUBSPOT_PRIVATE_APP_TOKEN');
  } else {
    const hs = crearHubSpot({ http, token: config.hubspot.token, apiUrl: config.hubspot.apiUrl });
    try {
      const r = await hs.solicitud('GET', `/crm/v3/pipelines/deals/${config.hubspot.pipelineId}`, undefined, { aceptar: [400, 404] });
      if (r.status !== 200) {
        mal(`HUBSPOT_PIPELINE_ID=${config.hubspot.pipelineId} no existe en HubSpot. Corre npm run hubspot:setup.`);
      } else {
        const ids = new Set(r.body.stages.map((s) => s.id));
        const faltan = ETAPAS.filter((e) => !ids.has(config.hubspot.etapas[e.clave]));
        if (faltan.length) mal(`IDs de etapa que no coinciden con el pipeline: ${faltan.map((e) => `HUBSPOT_ETAPA_${e.clave.toUpperCase()}`).join(', ')}`);
        else ok(`Pipeline "${r.body.label}" con sus ${ETAPAS.length} etapas mapeadas.`);
      }
      for (const prop of ['wa_telefono', 'producto', 'cantidad', 'fecha_entrega', 'empresa_cliente', 'resumen_ia', 'motivo_perdida']) {
        const p = await hs.solicitud('GET', `/crm/v3/properties/deals/${prop}`, undefined, { aceptar: [404] });
        if (p.status === 404) mal(`Falta la propiedad de negocio ${prop}`);
      }
      const propietarios = new Set((await hs.listarPropietarios()).map((o) => String(o.id)));
      const desconocidos = owners.filter((o) => !propietarios.has(String(o)));
      if (desconocidos.length) mal(`hubspot_owner_id de vendedores que no existen en HubSpot: ${desconocidos.join(', ')}`);
      else if (owners.length) ok('Todos los vendedores existen como usuarios de HubSpot.');
      if (config.hubspot.adminOwnerId && !propietarios.has(config.hubspot.adminOwnerId)) {
        mal(`ADMIN_HUBSPOT_OWNER_ID=${config.hubspot.adminOwnerId} no es un usuario de HubSpot`);
      }
    } catch (error) {
      mal(`HubSpot: ${error.message}`);
    }
  }

  // Claude
  if (!config.anthropic.apiKey) {
    mal('Falta ANTHROPIC_API_KEY');
  } else {
    const r = await http({
      method: 'GET',
      url: `${config.anthropic.apiUrl}/v1/models/${config.anthropic.modelo}`,
      headers: { 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (r.status === 200) ok(`Claude: modelo ${config.anthropic.modelo} disponible.`);
    else mal(`Claude: ${r.status} ${JSON.stringify(r.body)}`);
  }

  console.log(fallas ? `\n${fallas} problema(s) por resolver.` : '\nTodo listo.');
  process.exit(fallas ? 1 : 0);
}

main().catch((error) => {
  console.error(`✘ ${error.message}`);
  process.exit(1);
});
