#!/usr/bin/env node
'use strict';

// Apunta el webhook del número en 360dialog a n8n.
//
// Uso:
//   D360_WEBHOOK_URL=https://n8n.tudominio.com/webhook/merch-caracas/whatsapp \
//   D360_API_KEY=... D360_WEBHOOK_SECRET=... node scripts/configurar-webhook-360dialog.js

const { cargarEnv, http } = require('./lib');
const { configurarWebhook } = require('../src/d360');

async function main() {
  cargarEnv();
  const faltan = ['D360_API_KEY', 'D360_WEBHOOK_SECRET', 'D360_WEBHOOK_URL'].filter((k) => !process.env[k]);
  if (faltan.length) throw new Error(`Faltan variables: ${faltan.join(', ')}`);
  const r = await configurarWebhook({
    http,
    apiKey: process.env.D360_API_KEY,
    url: process.env.D360_WEBHOOK_URL,
    secreto: process.env.D360_WEBHOOK_SECRET,
    apiUrl: process.env.D360_API_URL || undefined,
  });
  if (!r.con_encabezado) console.log('360dialog no aceptó encabezados personalizados; se usa solo ?secreto= en la URL.');
  console.log(`✔ Webhook configurado: ${r.url}`);
  console.log('Configuración actual en 360dialog:', JSON.stringify(r.configuracion_actual));
}

main().catch((error) => {
  console.error(`✘ ${error.message}`);
  process.exit(1);
});
