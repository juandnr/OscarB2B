'use strict';

// Configura en 360dialog la URL a la que manda los webhooks del número.
// El secreto viaja como ?secreto= en la URL y también en el encabezado
// X-Webhook-Secret, por si la cuenta no reenvía encabezados personalizados.

async function configurarWebhook({ http, apiKey, url, secreto, apiUrl = 'https://waba-v2.360dialog.io' }) {
  if (!apiKey) throw new Error('Falta D360_API_KEY');
  if (!secreto) throw new Error('Falta el secreto del webhook');
  const destino = new URL(url);
  destino.searchParams.set('secreto', secreto);
  const headers = { 'D360-API-KEY': apiKey, 'Content-Type': 'application/json' };
  const endpoint = `${apiUrl}/v1/configs/webhook`;

  let conEncabezado = true;
  let r = await http({
    method: 'POST', url: endpoint, headers,
    body: { url: destino.toString(), headers: { 'X-Webhook-Secret': secreto } },
  });
  if (r.status === 400) {
    conEncabezado = false;
    r = await http({ method: 'POST', url: endpoint, headers, body: { url: destino.toString() } });
  }
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`360dialog respondió ${r.status}: ${JSON.stringify(r.body)}`);
  }
  const actual = await http({ method: 'GET', url: endpoint, headers });
  const oculto = (v) => JSON.stringify(v).split(secreto).join('***');
  return {
    url: url.toString(),
    con_encabezado: conEncabezado,
    configuracion_actual: JSON.parse(oculto(actual.body ?? null)),
  };
}

module.exports = { configurarWebhook };
