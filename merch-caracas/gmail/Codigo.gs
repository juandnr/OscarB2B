// Merch Caracas — del Gmail de la empresa al sistema de ventas.
//
// Cada 5 minutos manda a la función de Supabase los correos nuevos de esta
// cuenta: los recibidos (menos Promociones, Social, Notificaciones, Foros y
// Spam) y los enviados. Allá se decide cuáles son de clientes.
// Solo LEE el correo: no borra, no envía y no cambia nada.
//
// Instalación: ver supabase/GMAIL.md. Solo hay que llenar estas dos líneas:

const URL_FUNCION = 'https://TU-PROYECTO.supabase.co/functions/v1/merch';
const SECRETO = 'PEGA-AQUI-EL-SECRETO';

// ─────────────────────────────────────────────────────────────────────────────

const POR_CORRIDA = 40;        // correos como máximo en cada corrida
const MAX_TEXTO = 8000;        // caracteres del cuerpo de cada correo
const MARGEN_S = 600;          // vuelve a mirar los últimos 10 min por si un correo llegó tarde
const OMITIR = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
  'SPAM', 'TRASH', 'DRAFT', 'CHAT'];

// Correr una vez a mano: deja programada la revisión cada 5 minutos.
function instalar() {
  if (SECRETO.indexOf('PEGA-AQUI') === 0 || URL_FUNCION.indexOf('TU-PROYECTO') >= 0) {
    throw new Error('Falta llenar URL_FUNCION y SECRETO al principio del código.');
  }
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'revisarCorreo')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('revisarCorreo').timeBased().everyMinutes(5).create();
  const r = revisarCorreo();
  Logger.log(`Listo: el correo se revisa cada 5 minutos. Primera revisión: ${JSON.stringify(r)}`);
}

// Para dejar de mandar correos al sistema.
function desinstalar() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'revisarCorreo')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  Logger.log('Listo: ya no se revisa el correo.');
}

function revisarCorreo() {
  const props = PropertiesService.getScriptProperties();
  // La primera vez solo se toma la última hora (no se manda el historial).
  const desde = Number(props.getProperty('desde_ms')) || Date.now() - 60 * 60 * 1000;
  const yaEnviados = JSON.parse(props.getProperty('enviados') || '[]');
  const vistos = new Set(yaEnviados);

  // Gmail los lista del más nuevo al más viejo: se mandan del más viejo al más nuevo.
  const ids = listarIds(Math.floor(desde / 1000) - MARGEN_S).filter((id) => !vistos.has(id)).reverse();
  const lote = ids.slice(0, POR_CORRIDA);

  const correos = [];
  let maximo = desde;
  for (const id of lote) {
    const m = Gmail.Users.Messages.get('me', id, { format: 'full' });
    maximo = Math.max(maximo, Number(m.internalDate) || 0);
    const etiquetas = m.labelIds || [];
    const enviado = etiquetas.indexOf('SENT') >= 0;
    if (!enviado && etiquetas.some((e) => OMITIR.indexOf(e) >= 0)) continue;
    const h = cabeceras(m.payload);
    correos.push({
      id: m.id,
      hilo: m.threadId,
      de: h.from || '',
      para: h.to || '',
      cc: h.cc || '',
      asunto: h.subject || '',
      fecha: Number(m.internalDate),
      texto: cuerpo(m.payload).slice(0, MAX_TEXTO),
      etiquetas,
      cabeceras: {
        list_unsubscribe: Boolean(h['list-unsubscribe']),
        precedence: h.precedence || null,
        auto_submitted: h['auto-submitted'] || null,
      },
    });
  }

  // Se manda aunque no haya correos nuevos: así el sistema retoma los pendientes.
  const r = UrlFetchApp.fetch(`${URL_FUNCION.replace(/\/+$/, '')}/correo`, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Webhook-Secret': SECRETO },
    payload: JSON.stringify({ correos }),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) {
    throw new Error(`La función respondió ${r.getResponseCode()}: ${r.getContentText().slice(0, 300)}`);
  }

  props.setProperty('desde_ms', String(maximo));
  // Ids ya mandados (para el margen de 10 min). Una propiedad guarda hasta 9 KB.
  props.setProperty('enviados', JSON.stringify(yaEnviados.concat(lote).slice(-300)));
  return JSON.parse(r.getContentText());
}

function listarIds(despuesDe) {
  const ids = [];
  let pagina;
  do {
    const r = Gmail.Users.Messages.list('me', {
      q: `after:${despuesDe} -in:spam -in:trash -in:drafts -in:chats`,
      maxResults: 100,
      pageToken: pagina,
    });
    (r.messages || []).forEach((m) => ids.push(m.id));
    pagina = r.nextPageToken;
  } while (pagina && ids.length < 1000);
  return ids;
}

function cabeceras(payload) {
  const salida = {};
  ((payload && payload.headers) || []).forEach((h) => { salida[h.name.toLowerCase()] = h.value; });
  return salida;
}

// Texto del correo: la parte text/plain o, si no hay, el HTML sin etiquetas.
function cuerpo(payload) {
  let plano = null;
  let html = null;
  (function recorrer(p) {
    if (!p) return;
    if (p.body && p.body.data) {
      if (p.mimeType === 'text/plain' && plano === null) plano = decodificar(p.body.data);
      if (p.mimeType === 'text/html' && html === null) html = decodificar(p.body.data);
    }
    (p.parts || []).forEach(recorrer);
  })(payload);
  if (plano !== null) return plano;
  return html !== null ? sinHtml(html) : '';
}

function decodificar(data) {
  // El servicio de Gmail de Apps Script entrega los bytes; la API, base64 web-safe.
  const bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

function sinHtml(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
