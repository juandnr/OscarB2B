'use strict';

// F6 — Correo (Gmail). Corre cada vez que el script de Gmail manda correos
// (cada 5 minutos), y a mano con select merch.llamar('f6').
//
//   [Postgres f6_tomar_correos] → clasificar → [Postgres f6_guardar_resultados]
//     → alta en HubSpot y tareas respondidas, con los mismos pasos que F1.
//
// - Correo enviado a un cliente → se registra como respuesta (completa "Contestar").
// - Correo de alguien que ya es cliente → se registra y F2 lo analiza.
// - Correo automático o masivo (Promociones, boletines, no-reply...) → ignorado.
// - Remitente con contacto en HubSpot que tiene un negocio en el pipeline → cliente.
// - Remitente nuevo → Claude decide si es un cliente. Si lo es con confianza
//   ≥ 0.7, se registra y se crean contacto, negocio y tarea "Contestar".

const { preparar } = require('./comun');
const { claveCorreo, motivoAutomatico, textoMensaje } = require('../correo');
const { clasificarCorreo } = require('../claude');

const CONFIANZA_MINIMA = 0.7;

// Correo → mensaje con el formato de f1_registrar_mensajes.
function mensaje(correo, telefono, direccion, sufijo = '') {
  const entrante = direccion === 'entrante';
  return {
    id: `gmail:${correo.id}${sufijo}`,
    telefono,
    direccion,
    tipo: 'email',
    texto: textoMensaje(correo),
    media_id: null,
    ts: correo.fecha,
    nombre_wa: entrante ? correo.de_nombre || null : null,
    origen: entrante ? 'messages' : 'echo',
    raw: { gmail_id: correo.id, hilo: correo.hilo || null, asunto: correo.asunto || null },
  };
}

// Entrada: filas de f6_tomar_correos.
// Salida: un item { resultado: { correos, liberar, mensajes, errores } } para
// f6_guardar_resultados.
async function clasificar(filas, ctx) {
  if (!filas.length) return [];
  const { config, hs } = preparar(ctx, ['hubspot']);
  const inicio = Date.now();
  const resultado = { correos: [], liberar: [], mensajes: [], errores: [] };
  const decidir = (c, estado, motivo, cliente = null) => resultado.correos.push({ id: c.id, estado, motivo, cliente });

  // Los correos de un remitente nuevo se le muestran juntos a Claude.
  const nuevos = new Map();
  for (const c of filas) {
    if (c.direccion === 'saliente') {
      const destinos = c.clientes_destino || [];
      if (!destinos.length) {
        decidir(c, 'ignorado', 'enviado a alguien que no es cliente');
        continue;
      }
      destinos.forEach((d, i) => resultado.mensajes.push(mensaje(c, d, 'saliente', destinos.length > 1 ? `:${i}` : '')));
      decidir(c, 'cliente', 'respuesta a un cliente', destinos[0]);
      continue;
    }
    if (c.cliente_existente) {
      resultado.mensajes.push(mensaje(c, c.cliente_existente, 'entrante'));
      decidir(c, 'cliente', 'el remitente ya es cliente', c.cliente_existente);
      continue;
    }
    const automatico = motivoAutomatico(c, config.correoIgnorar);
    if (automatico) {
      decidir(c, 'ignorado', automatico);
      continue;
    }
    if (!nuevos.has(c.de_email)) nuevos.set(c.de_email, []);
    nuevos.get(c.de_email).push(c);
  }

  for (const [email, correos] of nuevos) {
    const clave = claveCorreo(email);
    const registrar = (motivo, nombre) => {
      for (const c of correos) {
        const m = mensaje(c, clave, 'entrante');
        m.nombre_wa = c.de_nombre || nombre || null;
        resultado.mensajes.push(m);
        decidir(c, 'cliente', motivo, clave);
      }
    };

    // Alguien que ya tiene negocio en HubSpot (por ejemplo, un cliente de
    // WhatsApp con su email, o uno que un vendedor creó a mano) es cliente.
    try {
      const contacto = await hs.buscarContactoPorEmail(email);
      if (contacto && (await hs.negociosDeContacto(contacto.id, config.hubspot.pipelineId)).length) {
        registrar('ya tiene un negocio en HubSpot');
        continue;
      }
    } catch (error) {
      resultado.liberar.push(...correos.map((c) => c.id));
      resultado.errores.push(`${email}: ${error.message}`);
      continue;
    }

    if (correos.some((c) => c.remitente_descartado)) {
      for (const c of correos) decidir(c, 'no_cliente', 'el remitente ya se descartó en los últimos 30 días');
      continue;
    }

    // Sin clave de Claude o sin tiempo: quedan pendientes para la siguiente corrida.
    if (!config.anthropic.apiKey || Date.now() - inicio > config.f6TiempoMaximoS * 1000) {
      resultado.liberar.push(...correos.map((c) => c.id));
      continue;
    }
    let veredicto;
    try {
      ({ analisis: veredicto } = await clasificarCorreo({
        http: ctx.http, config, correos: correos.slice(-3), esperar: ctx.esperar,
      }));
    } catch (error) {
      resultado.liberar.push(...correos.map((c) => c.id));
      resultado.errores.push(`${email}: ${error.message}`);
      continue;
    }
    const motivo = `${veredicto.motivo} (confianza ${veredicto.confianza})`;
    if (veredicto.es_cliente && veredicto.confianza >= CONFIANZA_MINIMA) {
      registrar(motivo, veredicto.nombre);
    } else {
      for (const c of correos) decidir(c, 'no_cliente', motivo);
    }
  }
  return [{ resultado }];
}

module.exports = { clasificar, CONFIANZA_MINIMA };
