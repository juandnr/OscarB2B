'use strict';

// Servidor de la Edge Function "merch" de Supabase. Rutas, bajo
// https://<proyecto>.supabase.co/functions/v1/merch/<ruta>:
//
//   GET  salud               estado de la instalación (no muestra secretos)
//   POST whatsapp            webhook de 360dialog (F1); pide el secreto del webhook
//   POST f2 | f3 | f4 | f5   flujos programados (los llama el cron)
//   POST hubspot-setup       crea pipeline y propiedades y guarda los IDs
//   POST configurar-webhook  apunta el webhook de 360dialog a esta función
//
// Las rutas POST salvo whatsapp exigen el encabezado x-cron-secreto (secreto
// guardado en Vault; se llaman con select merch.llamar('<ruta>')). Todo lo que
// tarda se hace después de responder y queda anotado en merch.bitacora.

const { crearOrquestador } = require('./orquestacion');
const { leerConfig, exigir } = require('./config');
const { secretoValido } = require('./whatsapp');
const { crearHubSpot } = require('./hubspot');
const { asegurarPipeline, asegurarPropiedades } = require('./hubspot-setup');
const { configurarWebhook } = require('./d360');

const ESQUEMA = 'merch';
const PROGRAMADAS = ['f2', 'f3', 'f4', 'f5'];

function iguales(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || x.length !== y.length) return false;
  let diferencia = 0;
  for (let i = 0; i < x.length; i++) diferencia |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diferencia === 0;
}

function responder(status, cuerpo) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

// consultar(sql, parametros) → filas; envBase: variables de entorno de la función;
// http: ver src/http.js; enSegundoPlano(promesa): EdgeRuntime.waitUntil en Supabase.
function crearManejador({ consultar, envBase, http, enSegundoPlano, ahora = () => new Date(), esperar }) {
  const orquestador = crearOrquestador({ consultar, esquema: ESQUEMA });

  async function secreto(nombre) {
    const [fila] = await consultar('select id, decrypted_secret as valor from vault.decrypted_secrets where name = $1', [nombre]);
    return fila || null;
  }

  // Secretos de la función + tabla merch.configuracion (manda la tabla) + secreto del webhook en Vault.
  async function entorno() {
    const env = { ...envBase };
    for (const { clave, valor } of await consultar(`select clave, valor from ${ESQUEMA}.configuracion`)) {
      if (valor !== null && String(valor).trim() !== '') env[clave] = String(valor).trim();
    }
    if (!env.D360_WEBHOOK_SECRET) {
      const s = await secreto('merch_webhook_secreto');
      env.D360_WEBHOOK_SECRET = s ? s.valor : '';
    }
    return env;
  }

  function urlPropia(request) {
    const base = envBase.SUPABASE_URL ? envBase.SUPABASE_URL.replace(/\/+$/, '') : new URL(request.url).origin;
    return `${base}/functions/v1/merch`;
  }

  // Guarda en Vault la URL de la función para que el cron sepa a dónde llamar.
  async function registrarUrl(url) {
    const actual = await secreto('merch_url_funcion');
    if (!actual) await consultar("select vault.create_secret($1, 'merch_url_funcion')", [url]);
    else if (actual.valor !== url) await consultar('select vault.update_secret($1::uuid, $2)', [actual.id, url]);
  }

  async function anotar(ruta, ok, detalle) {
    try {
      await consultar(`insert into ${ESQUEMA}.bitacora (ruta, ok, detalle) values ($1, $2, $3::text::jsonb)`, [ruta, ok, JSON.stringify(detalle ?? null)]);
    } catch (error) {
      console.error('No se pudo escribir en la bitácora:', error);
    }
  }

  function enFondo(ruta, trabajo) {
    const promesa = (async () => {
      try {
        await anotar(ruta, true, await trabajo());
      } catch (error) {
        console.error(`${ruta}:`, error);
        await anotar(ruta, false, { error: error.message });
      }
    })();
    enSegundoPlano(promesa);
    return promesa;
  }

  const ctx = (env) => ({ env, http, ahora, esperar });

  async function salud(request) {
    const url = urlPropia(request);
    await registrarUrl(url);
    const env = await entorno();
    const config = leerConfig(env);
    const faltan = (requisitos) => {
      try {
        exigir(config, requisitos);
        return [];
      } catch (error) {
        return error.message.replace('Faltan variables de entorno: ', '').split(', ');
      }
    };
    const activo = (f) => String(env[`${f.toUpperCase()}_ACTIVO`]).toLowerCase() === 'true';
    const [{ n }] = await consultar(`select count(*)::int as n from ${ESQUEMA}.vendedores where disponible`);
    const [{ w }] = await consultar(`select count(*)::int as w from ${ESQUEMA}.mensajes`);
    return {
      ok: true,
      url_funcion: url,
      modo_sombra: config.modoSombra,
      vendedores_disponibles: n,
      mensajes_recibidos: w,
      d360_api_key: Boolean(config.d360.apiKey),
      flujos: {
        f1: { faltan: faltan(['webhook', 'hubspot', 'horario']) },
        f2: { activo: activo('f2'), faltan: faltan(['hubspot', 'anthropic']) },
        f3: { activo: activo('f3'), faltan: faltan(['hubspot', 'horario']) },
        f4: { activo: activo('f4'), faltan: faltan(['hubspot']) },
        f5: { activo: activo('f5'), faltan: faltan(['hubspot']) },
      },
    };
  }

  async function hubspotSetup(env) {
    const config = leerConfig(env);
    if (!config.hubspot.token) throw new Error('Falta HUBSPOT_PRIVATE_APP_TOKEN en los secretos de la función');
    const hs = crearHubSpot({ http, token: config.hubspot.token, apiUrl: config.hubspot.apiUrl, esperar });
    const pasos = [];
    const { pipelineId, etapas } = await asegurarPipeline(hs, (m) => pasos.push(m));
    await asegurarPropiedades(hs, (m) => pasos.push(m));
    const valores = { HUBSPOT_PIPELINE_ID: pipelineId };
    for (const [clave, id] of Object.entries(etapas)) valores[`HUBSPOT_ETAPA_${clave.toUpperCase()}`] = id;
    await consultar(
      `insert into ${ESQUEMA}.configuracion (clave, valor, descripcion)
       select key, value, 'Lo llena hubspot-setup' from jsonb_each_text($1::text::jsonb)
       on conflict (clave) do update set valor = excluded.valor`,
      [JSON.stringify(valores)],
    );
    let usuarios = [];
    try {
      usuarios = (await hs.listarPropietarios()).map((o) => ({
        hubspot_owner_id: String(o.id), nombre: [o.firstName, o.lastName].filter(Boolean).join(' '), email: o.email || null,
      }));
    } catch (error) {
      pasos.push(`No se pudo listar los usuarios: ${error.message}`);
    }
    return { pipeline_id: pipelineId, etapas, pasos, usuarios };
  }

  async function webhook360(env) {
    const config = leerConfig(env);
    const url = await secreto('merch_url_funcion');
    if (!url) throw new Error('Falta registrar la URL de la función: abre /merch/salud una vez');
    return configurarWebhook({
      http, apiKey: config.d360.apiKey, url: `${url.valor}/whatsapp`, secreto: config.d360.webhookSecret, apiUrl: config.d360.apiUrl,
    });
  }

  return async function manejar(request) {
    const url = new URL(request.url);
    const ruta = url.pathname.replace(/\/+$/, '').split('/').pop();
    try {
      if (request.method === 'GET' && ruta === 'salud') return responder(200, await salud(request));
      if (request.method !== 'POST') return responder(405, { error: 'Método no permitido' });

      if (ruta === 'whatsapp') {
        const env = await entorno();
        const headers = {};
        request.headers.forEach((valor, clave) => { headers[clave.toLowerCase()] = valor; });
        const query = Object.fromEntries(url.searchParams);
        if (!secretoValido({ headers, query }, env.D360_WEBHOOK_SECRET)) return responder(401, { error: 'Secreto inválido' });
        const body = await request.json().catch(() => null);
        enFondo('f1', () => orquestador.f1([{ headers, query, body }], ctx(env)));
        return responder(200, { ok: true });
      }

      const esperado = await secreto('merch_cron_secreto');
      if (!esperado || !iguales(request.headers.get('x-cron-secreto'), esperado.valor)) {
        return responder(401, { error: 'No autorizado' });
      }
      const env = await entorno();

      if (PROGRAMADAS.includes(ruta)) {
        if (String(env[`${ruta.toUpperCase()}_ACTIVO`]).toLowerCase() !== 'true') {
          return responder(200, { omitido: `${ruta} está desactivado en merch.configuracion` });
        }
        enFondo(ruta, () => orquestador[ruta](ctx(env)));
        return responder(202, { aceptado: ruta });
      }
      if (ruta === 'hubspot-setup') {
        enFondo(ruta, () => hubspotSetup(env));
        return responder(202, { aceptado: ruta, resultado: 'ver merch.bitacora' });
      }
      if (ruta === 'configurar-webhook') {
        enFondo(ruta, () => webhook360(env));
        return responder(202, { aceptado: ruta, resultado: 'ver merch.bitacora' });
      }
      return responder(404, { error: `Ruta desconocida: ${ruta}` });
    } catch (error) {
      console.error(error);
      return responder(500, { error: error.message });
    }
  };
}

module.exports = { crearManejador, ESQUEMA };
