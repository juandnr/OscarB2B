'use strict';

// HubSpot y Claude simulados en memoria para las pruebas. Implementan solo los
// endpoints que usa el sistema, con la misma forma de respuesta.

const HUBSPOT_URL = 'http://hubspot.prueba';
const CLAUDE_URL = 'http://claude.prueba';

const ETAPAS_IDS = {
  nuevo: '101', solicitud: '102', cotizado: '103', verificar_pago: '104', pagado: '105',
  listo_para_enviar: '106', enviado: '107', entregado: '108', perdido: '109',
};

function envPrueba(extra = {}) {
  const env = {
    HUBSPOT_PRIVATE_APP_TOKEN: 'token-prueba',
    HUBSPOT_PIPELINE_ID: 'p1',
    HUBSPOT_API_URL: HUBSPOT_URL,
    ANTHROPIC_API_KEY: 'clave-prueba',
    ANTHROPIC_API_URL: CLAUDE_URL,
    ANTHROPIC_MODEL: 'claude-sonnet-5-5',
    D360_WEBHOOK_SECRET: 'secreto-de-prueba-123456789',
    HORARIO_LABORAL: 'lun-vie 08:00-17:00; sab 08:00-12:00',
    TIMEZONE: 'America/Caracas',
    ADMIN_HUBSPOT_OWNER_ID: '900',
    ...extra,
  };
  for (const [clave, id] of Object.entries(ETAPAS_IDS)) env[`HUBSPOT_ETAPA_${clave.toUpperCase()}`] = id;
  return env;
}

function coincide(obj, filtro) {
  if (filtro.propertyName === 'associations.contact') {
    return (obj.asociados.contacts || []).includes(String(filtro.value));
  }
  const valor = obj.properties[filtro.propertyName];
  switch (filtro.operator) {
    case 'EQ': return valor !== undefined && valor !== null && String(valor) === String(filtro.value);
    case 'IN': return filtro.values.map(String).includes(String(valor));
    case 'GTE': return Number(new Date(valor).getTime()) >= Number(filtro.value);
    default: throw new Error(`Operador no simulado: ${filtro.operator}`);
  }
}

const TIPO_ASOC = { 3: 'contacts', 204: 'contacts', 216: 'deals', 202: 'contacts', 214: 'deals' };

function crearHubSpotFalso() {
  const datos = { contacts: {}, deals: {}, tasks: {}, notes: {} };
  const owners = [
    { id: '1', firstName: 'Ana', lastName: 'Pérez', email: 'ana@x.com' },
    { id: '2', firstName: 'Beto', lastName: 'Gil', email: 'beto@x.com' },
    { id: '900', firstName: 'Oscar', lastName: '', email: 'oscar@x.com' },
  ];
  const llamadas = [];
  let secuencia = 5000;
  const errores = []; // [{ metodo, patron, status, veces }]

  const pipelines = [];
  const propiedades = {};
  const grupos = [];

  function crear(tipo, cuerpo) {
    const id = String(secuencia++);
    const ahora = new Date().toISOString();
    const obj = {
      id,
      properties: { ...cuerpo.properties, createdate: ahora, hs_lastmodifieddate: ahora },
      asociados: {},
      createdAt: ahora,
    };
    for (const a of cuerpo.associations || []) {
      const destino = TIPO_ASOC[a.types[0].associationTypeId];
      (obj.asociados[destino] = obj.asociados[destino] || []).push(String(a.to.id));
    }
    if (tipo === 'deals' && obj.asociados.contacts) {
      for (const c of obj.asociados.contacts) {
        const contacto = datos.contacts[c];
        if (contacto) (contacto.asociados.deals = contacto.asociados.deals || []).push(id);
      }
    }
    datos[tipo][id] = obj;
    return obj;
  }

  function publico(obj) {
    return { id: obj.id, properties: { ...obj.properties }, createdAt: obj.createdAt };
  }

  async function http({ method, url, body }) {
    const u = new URL(url);
    const ruta = u.pathname;
    llamadas.push({ method, ruta, body });

    for (const e of errores) {
      if (e.veces > 0 && e.metodo === method && e.patron.test(ruta)) {
        e.veces -= 1;
        return { status: e.status, body: { message: 'error simulado' }, headers: {} };
      }
    }

    let m;
    if (method === 'POST' && (m = /^\/crm\/v3\/objects\/(\w+)\/search$/.exec(ruta))) {
      const todos = Object.values(datos[m[1]]);
      const resultados = todos.filter((o) => (body.filterGroups || []).some((g) => g.filters.every((f) => coincide(o, f))));
      resultados.sort((a, b) => Number(b.id) - Number(a.id));
      return { status: 200, body: { total: resultados.length, results: resultados.slice(0, body.limit || 10).map(publico) }, headers: {} };
    }
    if (method === 'POST' && (m = /^\/crm\/v3\/objects\/(\w+)\/batch\/read$/.exec(ruta))) {
      const results = body.inputs.map((i) => datos[m[1]][i.id]).filter(Boolean).map(publico);
      const status = results.length === body.inputs.length ? 200 : 207;
      return { status, body: { status: 'COMPLETE', results }, headers: {} };
    }
    if (method === 'POST' && (m = /^\/crm\/v3\/objects\/(\w+)$/.exec(ruta))) {
      return { status: 201, body: publico(crear(m[1], body)), headers: {} };
    }
    if ((method === 'PATCH' || method === 'GET') && (m = /^\/crm\/v3\/objects\/(\w+)\/(\w+)$/.exec(ruta))) {
      const obj = datos[m[1]][m[2]];
      if (!obj) return { status: 404, body: { message: 'not found' }, headers: {} };
      if (method === 'PATCH') {
        Object.assign(obj.properties, body.properties, { hs_lastmodifieddate: new Date().toISOString() });
        if (m[1] === 'tasks' && body.properties.hs_task_status === 'COMPLETED') {
          obj.properties.hs_task_completion_date = new Date().toISOString();
        }
      }
      return { status: 200, body: publico(obj), headers: {} };
    }
    if (method === 'GET' && ruta === '/crm/v3/pipelines/deals') {
      return { status: 200, body: { results: JSON.parse(JSON.stringify(pipelines)) }, headers: {} };
    }
    if (method === 'POST' && ruta === '/crm/v3/pipelines/deals') {
      const p = { id: `pl${secuencia++}`, label: body.label, stages: body.stages.map((e) => ({ ...e, id: String(secuencia++) })) };
      pipelines.push(p);
      return { status: 201, body: p, headers: {} };
    }
    if (method === 'POST' && ruta === '/crm/v3/properties/deals/groups') {
      if (grupos.includes(body.name)) return { status: 409, body: { message: 'existe' }, headers: {} };
      grupos.push(body.name);
      return { status: 201, body, headers: {} };
    }
    if ((m = /^\/crm\/v3\/properties\/deals\/(\w+)$/.exec(ruta))) {
      if (method === 'GET') {
        return propiedades[m[1]] ? { status: 200, body: propiedades[m[1]], headers: {} } : { status: 404, body: { message: 'no' }, headers: {} };
      }
      if (method === 'PATCH') {
        Object.assign(propiedades[m[1]], body);
        return { status: 200, body: propiedades[m[1]], headers: {} };
      }
    }
    if (method === 'POST' && ruta === '/crm/v3/properties/deals') {
      propiedades[body.name] = body;
      return { status: 201, body, headers: {} };
    }
    if (method === 'GET' && ruta === '/crm/v3/owners') {
      return { status: 200, body: { results: owners }, headers: {} };
    }
    throw new Error(`Endpoint de HubSpot no simulado: ${method} ${ruta}`);
  }

  return {
    http,
    datos,
    pipelines,
    propiedades,
    llamadas,
    fallar(metodo, patron, status, veces = 1) {
      errores.push({ metodo, patron, status, veces });
    },
    // atajos para preparar escenarios
    agregar(tipo, properties, asociados = {}) {
      const obj = crear(tipo, { properties });
      obj.asociados = asociados;
      return obj;
    },
    completarTarea(id) {
      datos.tasks[id].properties.hs_task_status = 'COMPLETED';
      datos.tasks[id].properties.hs_task_completion_date = new Date().toISOString();
    },
    tareas() {
      return Object.values(datos.tasks);
    },
    notas() {
      return Object.values(datos.notes);
    },
  };
}

// Claude simulado: devuelve en orden las respuestas encoladas.
function crearClaudeFalso() {
  const cola = [];
  const solicitudes = [];
  async function http({ body }) {
    solicitudes.push(body);
    const siguiente = cola.shift();
    if (!siguiente) throw new Error('Claude falso: no hay respuestas encoladas');
    if (siguiente.status) return { status: siguiente.status, body: siguiente.body || {}, headers: siguiente.headers || {} };
    const texto = typeof siguiente.json === 'string' ? siguiente.json : JSON.stringify(siguiente.json);
    return {
      status: 200,
      body: {
        model: body.model,
        stop_reason: siguiente.stop_reason || 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: texto }],
        usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 },
      },
      headers: {},
    };
  }
  return {
    http,
    solicitudes,
    responder(json, extra = {}) {
      cola.push({ json, ...extra });
    },
    responderError(status, body, headers) {
      cola.push({ status, body, headers });
    },
  };
}

function analisis(extra = {}) {
  return {
    etapa_detectada: 'sin_cambio',
    confianza: 0.9,
    motivo: 'El cliente escribió "hola".',
    datos_pedido: { producto: null, cantidad: null, fecha_entrega: null, empresa_cliente: null },
    tareas_nuevas: [],
    resumen: 'El cliente saludó.',
    ...extra,
  };
}

// ctx para los pasos de flujo, con reloj fijo y sin esperas reales.
function crearCtx({ env = envPrueba(), hubspot = crearHubSpotFalso(), claude = crearClaudeFalso(), ahora = new Date() } = {}) {
  return {
    hubspot,
    claude,
    ctx: {
      env,
      ahora: () => new Date(ahora),
      esperar: async () => {},
      http: (o) => (o.url.startsWith(CLAUDE_URL) ? claude.http(o) : hubspot.http(o)),
    },
  };
}

module.exports = {
  ETAPAS_IDS,
  envPrueba,
  crearHubSpotFalso,
  crearClaudeFalso,
  crearCtx,
  analisis,
};
