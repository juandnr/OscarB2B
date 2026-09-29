'use strict';

// Lee la configuración desde variables de entorno ($env en n8n, process.env en scripts).

const { CLAVES_ETAPA } = require('./etapas');

function entero(valor, porDefecto) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return porDefecto;
  const n = Number(valor);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido: "${valor}"`);
  return n;
}

function texto(valor) {
  if (valor === undefined || valor === null) return '';
  return String(valor).trim();
}

function leerConfig(env) {
  const etapas = {};
  for (const clave of CLAVES_ETAPA) {
    const id = texto(env[`HUBSPOT_ETAPA_${clave.toUpperCase()}`]);
    if (id) etapas[clave] = id;
  }

  return {
    timezone: texto(env.TIMEZONE) || 'America/Caracas',
    horarioLaboral: texto(env.HORARIO_LABORAL),
    feriados: texto(env.FERIADOS),
    debounceMin: entero(env.DEBOUNCE_MIN, 5),
    slaNuevoMin: entero(env.SLA_RESPUESTA_NUEVO_MIN, 15),
    slaCursoMin: entero(env.SLA_RESPUESTA_CURSO_MIN, 120),
    slaSeguimientoHoras: entero(env.SLA_SEGUIMIENTO_HORAS, 48),
    escalarMin: entero(env.ESCALAR_MIN, 60),
    // F2 escribe solo resumen_ia + nota mientras MODO_SOMBRA no sea "false".
    modoSombra: texto(env.MODO_SOMBRA).toLowerCase() !== 'false',
    f2Lote: entero(env.F2_LOTE, 8),
    // Segundos que F2 dedica a analizar por corrida (Supabase corta a los 150 s).
    f2TiempoMaximoS: entero(env.F2_TIEMPO_MAXIMO_S, 200),
    d360: {
      webhookSecret: texto(env.D360_WEBHOOK_SECRET),
      apiKey: texto(env.D360_API_KEY),
      apiUrl: texto(env.D360_API_URL) || 'https://waba-v2.360dialog.io',
    },
    hubspot: {
      token: texto(env.HUBSPOT_PRIVATE_APP_TOKEN),
      pipelineId: texto(env.HUBSPOT_PIPELINE_ID),
      etapas,
      adminOwnerId: texto(env.ADMIN_HUBSPOT_OWNER_ID),
      apiUrl: texto(env.HUBSPOT_API_URL) || 'https://api.hubapi.com',
    },
    anthropic: {
      apiKey: texto(env.ANTHROPIC_API_KEY),
      modelo: texto(env.ANTHROPIC_MODEL) || 'claude-sonnet-5-5',
      esfuerzo: texto(env.ANTHROPIC_EFFORT) || 'low',
      // "default" activa el reintento del lado del servidor con otro modelo si
      // el modelo principal rechaza la solicitud; "no" lo desactiva.
      fallback: texto(env.ANTHROPIC_FALLBACK) || 'default',
      apiUrl: texto(env.ANTHROPIC_API_URL) || 'https://api.anthropic.com',
    },
  };
}

// Lanza un error claro si faltan valores obligatorios para un flujo.
function exigir(config, requisitos) {
  const faltan = [];
  for (const r of requisitos) {
    switch (r) {
      case 'hubspot':
        if (!config.hubspot.token) faltan.push('HUBSPOT_PRIVATE_APP_TOKEN');
        if (!config.hubspot.pipelineId) faltan.push('HUBSPOT_PIPELINE_ID');
        for (const clave of CLAVES_ETAPA) {
          if (!config.hubspot.etapas[clave]) faltan.push(`HUBSPOT_ETAPA_${clave.toUpperCase()}`);
        }
        break;
      case 'admin':
        if (!config.hubspot.adminOwnerId) faltan.push('ADMIN_HUBSPOT_OWNER_ID');
        break;
      case 'anthropic':
        if (!config.anthropic.apiKey) faltan.push('ANTHROPIC_API_KEY');
        break;
      case 'horario':
        if (!config.horarioLaboral) faltan.push('HORARIO_LABORAL');
        break;
      case 'webhook':
        if (!config.d360.webhookSecret) faltan.push('D360_WEBHOOK_SECRET');
        break;
      default:
        throw new Error(`Requisito desconocido: ${r}`);
    }
  }
  if (faltan.length) {
    throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
  }
}

module.exports = { leerConfig, exigir };
