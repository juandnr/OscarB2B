#!/usr/bin/env node
'use strict';

// Apunta el webhook del número en 360dialog a n8n.
//
// Uso:
//   D360_WEBHOOK_URL=https://n8n.tudominio.com/webhook/merch-caracas/whatsapp \
//   D360_API_KEY=... D360_WEBHOOK_SECRET=... node scripts/configurar-webhook-360dialog.js
//
// El secreto viaja en el encabezado X-Webhook-Secret y también como ?secreto=
// en la URL, por si la cuenta de 360dialog no reenvía encabezados personalizados.

const { cargarEnv, http } = require('./lib');

const API = process.env.D360_API_URL || 'https://waba-v2.360dialog.io';

async function main() {
  cargarEnv();
  const { D360_API_KEY: clave, D360_WEBHOOK_SECRET: secreto, D360_WEBHOOK_URL: base } = process.env;
  const faltan = ['D360_API_KEY', 'D360_WEBHOOK_SECRET', 'D360_WEBHOOK_URL'].filter((k) => !process.env[k]);
  if (faltan.length) throw new Error(`Faltan variables: ${faltan.join(', ')}`);

  const url = new URL(base);
  url.searchParams.set('secreto', secreto);
  const headers = { 'D360-API-KEY': clave, 'Content-Type': 'application/json' };

  let r = await http({
    method: 'POST', url: `${API}/v1/configs/webhook`, headers,
    body: { url: url.toString(), headers: { 'X-Webhook-Secret': secreto } },
  });
  if (r.status === 400) {
    console.log('360dialog no aceptó encabezados personalizados; se usa solo ?secreto= en la URL.');
    r = await http({ method: 'POST', url: `${API}/v1/configs/webhook`, headers, body: { url: url.toString() } });
  }
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`360dialog respondió ${r.status}: ${JSON.stringify(r.body)}`);
  }
  console.log(`✔ Webhook configurado: ${base}`);
  const actual = await http({ method: 'GET', url: `${API}/v1/configs/webhook`, headers });
  console.log(`Configuración actual en 360dialog (${actual.status}):`, JSON.stringify(actual.body).split(secreto).join('***'));
}

main().catch((error) => {
  console.error(`✘ ${error.message}`);
  process.exit(1);
});
