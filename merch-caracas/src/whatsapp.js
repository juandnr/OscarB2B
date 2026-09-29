'use strict';

// Normaliza los webhooks de 360dialog (formato de la Cloud API de Meta) a una
// lista plana de mensajes. Campos que se procesan:
//   messages            → mensajes que escribe el cliente (entrante)
//   smb_message_echoes  → lo que envían los vendedores desde la app (saliente)
//   history             → sincronización inicial del historial de la app
// Los estados de entrega (value.statuses) y cualquier otro campo se ignoran.

const { aE164, soloDigitos } = require('./telefono');

const MEDIA = ['image', 'video', 'audio', 'document', 'sticker'];

const ETIQUETA_MEDIA = {
  image: 'imagen',
  video: 'video',
  audio: 'nota de voz o audio',
  document: 'documento',
  sticker: 'sticker',
};

function extraerTexto(msg) {
  const tipo = msg.type;
  const cuerpo = msg[tipo] || {};
  let texto = null;

  if (tipo === 'text') {
    texto = cuerpo.body || null;
  } else if (MEDIA.includes(tipo)) {
    const partes = [`[${ETIQUETA_MEDIA[tipo]}${cuerpo.filename ? `: ${cuerpo.filename}` : ''}]`];
    if (cuerpo.caption) partes.push(cuerpo.caption);
    texto = partes.join(' ');
  } else if (tipo === 'interactive') {
    const r = cuerpo.button_reply || cuerpo.list_reply || {};
    texto = [r.title, r.description].filter(Boolean).join(' — ') || (cuerpo.nfm_reply && cuerpo.nfm_reply.body) || null;
  } else if (tipo === 'button') {
    texto = cuerpo.text || null;
  } else if (tipo === 'location') {
    texto = `[ubicación] ${[cuerpo.name, cuerpo.address].filter(Boolean).join(', ') || `${cuerpo.latitude},${cuerpo.longitude}`}`;
  } else if (tipo === 'contacts') {
    const nombres = (msg.contacts || []).map((c) => (c.name && c.name.formatted_name) || '').filter(Boolean);
    texto = `[contacto compartido] ${nombres.join(', ')}`.trim();
  } else if (tipo === 'reaction') {
    texto = cuerpo.emoji ? `[reacción ${cuerpo.emoji}]` : '[reacción eliminada]';
  } else if (tipo === 'order') {
    const items = (cuerpo.product_items || [])
      .map((i) => `${i.quantity} x ${i.product_retailer_id}`)
      .join(', ');
    texto = `[pedido del catálogo] ${items}${cuerpo.text ? ` — ${cuerpo.text}` : ''}`;
  } else if (tipo === 'system') {
    texto = cuerpo.body || null;
  } else if (cuerpo && typeof cuerpo === 'object') {
    texto = cuerpo.body || cuerpo.text || cuerpo.caption || null;
  }

  // Anuncios "clic a WhatsApp": el cliente llega desde un anuncio.
  if (msg.referral && (msg.referral.headline || msg.referral.body)) {
    const anuncio = [msg.referral.headline, msg.referral.body].filter(Boolean).join(' — ');
    texto = `[llegó desde anuncio: ${anuncio}] ${texto || ''}`.trim();
  }
  return texto;
}

function mediaId(msg) {
  const cuerpo = msg[msg.type];
  return MEDIA.includes(msg.type) && cuerpo && cuerpo.id ? cuerpo.id : null;
}

function ts(timestamp) {
  const segundos = Number(timestamp);
  if (!Number.isFinite(segundos)) throw new Error(`Timestamp inválido: ${timestamp}`);
  return new Date(segundos * 1000).toISOString();
}

function construir(msg, { telefono, direccion, origen, nombre }) {
  return {
    id: msg.id,
    telefono: aE164(telefono),
    direccion,
    tipo: msg.type || 'unknown',
    texto: extraerTexto(msg),
    media_id: mediaId(msg),
    ts: ts(msg.timestamp),
    nombre_wa: nombre || null,
    origen,
    raw: msg,
  };
}

// body: cuerpo JSON del webhook. Devuelve { mensajes, ignorados }.
function normalizarWebhook(body) {
  const mensajes = [];
  const ignorados = [];
  const agregar = (msg, opciones) => {
    try {
      mensajes.push(construir(msg, opciones));
    } catch (error) {
      ignorados.push(`mensaje ${msg && msg.id}: ${error.message}`);
    }
  };
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    ignorados.push('payload sin object=whatsapp_business_account');
    return { mensajes, ignorados };
  }

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const campo = change.field;

      if (campo === 'messages') {
        const nombres = {};
        for (const c of value.contacts || []) {
          if (c.wa_id) nombres[soloDigitos(c.wa_id)] = c.profile && c.profile.name;
        }
        for (const msg of value.messages || []) {
          agregar(msg, {
            telefono: msg.from,
            direccion: 'entrante',
            origen: 'messages',
            nombre: nombres[soloDigitos(msg.from)],
          });
        }
        if (value.statuses) ignorados.push(`${value.statuses.length} estado(s) de entrega`);
      } else if (campo === 'smb_message_echoes') {
        for (const msg of value.message_echoes || []) {
          agregar(msg, { telefono: msg.to, direccion: 'saliente', origen: 'echo' });
        }
      } else if (campo === 'history') {
        for (const bloque of value.history || []) {
          if (bloque.errors) ignorados.push(`history con error: ${JSON.stringify(bloque.errors)}`);
          for (const hilo of bloque.threads || []) {
            const cliente = soloDigitos(hilo.id);
            for (const msg of hilo.messages || []) {
              const delCliente = soloDigitos(msg.from) === cliente;
              agregar(msg, {
                telefono: cliente,
                direccion: delCliente ? 'entrante' : 'saliente',
                origen: 'history',
              });
            }
          }
        }
      } else {
        ignorados.push(`campo ${campo}`);
      }
    }
  }
  return { mensajes, ignorados };
}

// El secreto puede llegar como encabezado (X-Webhook-Secret) o en la URL (?secreto=).
function secretoValido(entrada, secreto) {
  if (!secreto) throw new Error('D360_WEBHOOK_SECRET no está configurado');
  const headers = entrada.headers || {};
  const query = entrada.query || {};
  const recibido = headers['x-webhook-secret'] || query.secreto || '';
  if (recibido.length !== secreto.length) return false;
  let diferencia = 0;
  for (let i = 0; i < secreto.length; i++) diferencia |= recibido.charCodeAt(i) ^ secreto.charCodeAt(i);
  return diferencia === 0;
}

module.exports = { normalizarWebhook, extraerTexto, secretoValido };
