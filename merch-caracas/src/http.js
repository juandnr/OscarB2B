'use strict';

// Implementación de la función http de los módulos con fetch (Node 18+ y Deno).
//   http({ method, url, headers, body, timeout }) → { status, body, headers }
// maxTimeoutMs recorta los tiempos de espera largos (Supabase corta a los 150 s).

function crearHttp({ fetch: fetchImpl = globalThis.fetch, maxTimeoutMs = Infinity } = {}) {
  return async function http({ method, url, headers, body, timeout }) {
    const r = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeout || 30000, maxTimeoutMs)),
    });
    const texto = await r.text();
    let json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch (error) {
      json = texto;
    }
    return { status: r.status, body: json, headers: Object.fromEntries(r.headers) };
  };
}

module.exports = { crearHttp };
