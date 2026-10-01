'use strict';

// Canal de correo: lo que manda el script de Gmail, las direcciones y los
// filtros de correos automáticos o masivos.
//
// Los clientes de correo usan como clave 'correo:<email>' en el mismo campo
// que los de WhatsApp usan para el teléfono.

const PREFIJO = 'correo:';

const esCorreo = (clave) => typeof clave === 'string' && clave.startsWith(PREFIJO);
const claveCorreo = (email) => `${PREFIJO}${String(email).trim().toLowerCase()}`;
const emailDe = (clave) => (esCorreo(clave) ? clave.slice(PREFIJO.length) : null);

const RE_EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// "Juan Pérez <juan@x.com>" | "juan@x.com" → { nombre, email } (email en minúsculas).
function direccion(texto) {
  const t = String(texto || '').trim();
  const m = RE_EMAIL.exec(t);
  if (!m) return null;
  const email = m[0].toLowerCase();
  let nombre = t.slice(0, m.index).replace(/[<"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!nombre || nombre.toLowerCase() === email) nombre = null;
  return { nombre, email };
}

// "a@x.com, \"Pérez, Juan\" <b@y.com>" → ['a@x.com', 'b@y.com']
function direcciones(texto) {
  const salida = [];
  const re = new RegExp(RE_EMAIL.source, 'g');
  let m;
  while ((m = re.exec(String(texto || '')))) salida.push(m[0].toLowerCase());
  return [...new Set(salida)];
}

// Quita las citas del correo anterior, la firma separada con "-- " y los
// espacios de más. Deja como máximo `maximo` caracteres.
const RE_ESCRIBIO = /^(el|on)\s.{0,300}(escribió|wrote|a écrit)\s*:?\s*$/i; // "El lun, 1 oct 2026, Juan <...> escribió:"
const CORTES = [
  RE_ESCRIBIO,
  /^-{2,}\s*(mensaje original|original message|forwarded message|mensaje reenviado)\s*-{2,}/i,
  /^_{10,}$/,
  /^--\s*$/, // firma
];
// Encabezado de Outlook al responder: "De: ..." seguido de "Enviado: ..." o "Fecha: ...".
const RE_DE = /^(de|from)\s*:\s*\S/i;
const RE_ENVIADO = /^(enviado|sent|fecha|date|para|to)\s*:/i;

function limpiarTexto(texto, maximo = 4000) {
  const lineas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
  const salida = [];
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const t = l.trim();
    if (t.startsWith('>')) continue;
    const siguiente = (lineas[i + 1] || '').trim();
    const corta = CORTES.some((re) => re.test(t))
      || RE_ESCRIBIO.test(`${t} ${siguiente}`) // Gmail parte a veces "El ... escribió:" en dos líneas
      || (RE_DE.test(t) && RE_ENVIADO.test(siguiente));
    if (corta && salida.some((x) => x.trim())) break;
    salida.push(l.replace(/\s+$/, ''));
  }
  const limpio = salida.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return limpio.length > maximo ? `${limpio.slice(0, maximo)}…` : limpio;
}

// Lo que manda el script de Gmail → filas para f6_guardar_correos.
//   { correos: [{ id, hilo, de, para, cc, asunto, fecha, texto, etiquetas, cabeceras }] }
function normalizarLote(cuerpo) {
  const salida = [];
  for (const c of (cuerpo && Array.isArray(cuerpo.correos) ? cuerpo.correos : [])) {
    const de = direccion(c.de);
    const fecha = new Date(typeof c.fecha === 'number' || /^\d+$/.test(String(c.fecha)) ? Number(c.fecha) : c.fecha);
    if (!c.id || !de || Number.isNaN(fecha.getTime())) continue;
    const etiquetas = Array.isArray(c.etiquetas) ? c.etiquetas.map(String) : [];
    const cab = c.cabeceras || {};
    salida.push({
      id: String(c.id),
      hilo: c.hilo ? String(c.hilo) : null,
      direccion: etiquetas.includes('SENT') ? 'saliente' : 'entrante',
      de_email: de.email,
      de_nombre: de.nombre,
      destinatarios: direcciones(`${c.para || ''}, ${c.cc || ''}`),
      asunto: c.asunto ? String(c.asunto).trim().slice(0, 300) : null,
      texto: limpiarTexto(c.texto),
      fecha: fecha.toISOString(),
      etiquetas,
      cabeceras: {
        list_unsubscribe: Boolean(cab.list_unsubscribe),
        precedence: cab.precedence ? String(cab.precedence).toLowerCase() : null,
        auto_submitted: cab.auto_submitted ? String(cab.auto_submitted).toLowerCase() : null,
      },
    });
  }
  return salida;
}

const CATEGORIAS = {
  CATEGORY_PROMOTIONS: 'Promociones',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_UPDATES: 'Notificaciones',
  CATEGORY_FORUMS: 'Foros',
  SPAM: 'Spam',
  TRASH: 'Papelera',
};

const REMITENTE_AUTOMATICO = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notificacion(es)?|notifications?|alertas?|alerts?|newsletters?|boletin(es)?|news)([+._-]|@|$)/i;

// Motivo por el que un correo entrante se descarta sin consultar a Claude, o null.
//   ignorar: emails o dominios (sin @) que nunca son clientes.
function motivoAutomatico(correo, ignorar = []) {
  for (const e of correo.etiquetas || []) {
    if (CATEGORIAS[e]) return `categoría de Gmail: ${CATEGORIAS[e]}`;
  }
  const email = String(correo.de_email || '').toLowerCase();
  const dominio = email.split('@')[1] || '';
  for (const regla of ignorar) {
    const r = regla.trim().toLowerCase().replace(/^@/, '');
    if (r && (email === r || dominio === r || dominio.endsWith(`.${r}`))) return `remitente en CORREO_IGNORAR (${r})`;
  }
  if (REMITENTE_AUTOMATICO.test(email.split('@')[0] || '')) return 'remitente automático';
  const cab = correo.cabeceras || {};
  if (cab.list_unsubscribe) return 'correo masivo (trae enlace para darse de baja)';
  if (['bulk', 'list', 'junk'].includes(cab.precedence)) return 'correo masivo';
  if (cab.auto_submitted && cab.auto_submitted !== 'no') return 'respuesta automática';
  return null;
}

// Texto del mensaje que ven F2 y los vendedores.
function textoMensaje(correo, maximo = 4000) {
  const asunto = correo.asunto ? `Asunto: ${correo.asunto}\n\n` : '';
  const cuerpo = String(correo.texto || '').trim() || '[correo sin texto]';
  return `${asunto}${cuerpo}`.slice(0, maximo);
}

module.exports = {
  PREFIJO,
  esCorreo,
  claveCorreo,
  emailDe,
  direccion,
  direcciones,
  limpiarTexto,
  normalizarLote,
  motivoAutomatico,
  textoMensaje,
};
