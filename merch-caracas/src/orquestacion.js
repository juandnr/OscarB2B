'use strict';

// Encadena los pasos de F1–F5 con las funciones de Postgres, en el mismo orden
// que los nodos de los flujos de n8n. Lo usa la función de Supabase.
//
// consultar(sql, parametros) → Promise<filas>. Las filas se pasan por JSON
// para que las fechas lleguen como texto ISO, igual que en n8n.

const f1 = require('./flujos/f1');
const f2 = require('./flujos/f2');
const f3 = require('./flujos/f3');
const f4 = require('./flujos/f4');
const f5 = require('./flujos/f5');
const { leerConfig } = require('./config');

function crearOrquestador({ consultar, esquema = null }) {
  const fn = (nombre) => (esquema ? `${esquema}.${nombre}` : nombre);
  const json = (v) => JSON.stringify(v);
  const filas = async (sql, parametros = []) => JSON.parse(JSON.stringify(await consultar(sql, parametros)));
  const registrarCambios = (cambios) => filas(`select ${fn('registrar_cambios')}($1::text::jsonb) as resultado`, [json(cambios)]);

  return {
    // entrada: [{ headers, query, body }] como llega el webhook.
    async f1(entrada, ctx) {
      const [normalizado] = await f1.normalizar(entrada, ctx);
      if (!normalizado) return { mensajes: 0 };
      const registradas = await filas(`select * from ${fn('f1_registrar_mensajes')}($1::text::jsonb)`, [json(normalizado.mensajes)]);
      const resumen = { mensajes: normalizado.mensajes.length, clientes: registradas.length, altas: 0, respondidas: 0 };

      // Las dos ramas son independientes: si falla el alta, igual se completan
      // las tareas respondidas, y el error se informa al final.
      let errorAlta = null;
      try {
        const [busqueda] = await f1.buscarEnHubspot(registradas, ctx);
        if (busqueda) {
          const asignados = await filas(`select * from ${fn('f1_asignar_vendedor')}($1::text::jsonb)`, [json(busqueda.asignaciones)]);
          const [creado] = await f1.crearEnHubspot(asignados, ctx, { busquedas: busqueda.busquedas });
          await registrarCambios(creado.cambios);
          resumen.altas = asignados.length;
        }
      } catch (error) {
        errorAlta = error;
      }
      const [respondidas] = await f1.completarRespondidas(registradas, ctx);
      if (respondidas) {
        await registrarCambios(respondidas.cambios);
        resumen.respondidas = respondidas.cambios.tareas_estado.length;
      }
      if (errorAlta) throw errorAlta;
      return resumen;
    },

    async f2(ctx) {
      const config = leerConfig(ctx.env);
      const pendientes = await filas(`select * from ${fn('f2_tomar_pendientes')}($1::int, $2::int)`, [config.debounceMin, config.f2Lote]);
      if (!pendientes.length) return { clientes: 0 };
      const [{ resultados }] = await f2.analizar(pendientes, ctx);
      const [guardado] = await filas(`select ${fn('f2_guardar_resultados')}($1::text::jsonb) as resultado`, [json(resultados)]);
      return { clientes: pendientes.length, ...guardado.resultado };
    },

    async f3(ctx) {
      const estado = await filas(`select * from ${fn('f3_estado')}()`);
      if (!estado.length) return { clientes: 0 };
      const [salida] = await f3.revisar(estado, ctx);
      if (!salida) return { clientes: estado.length, fuera_de_horario: true };
      await registrarCambios(salida.cambios);
      return { clientes: estado.length, tareas_nuevas: salida.cambios.tareas_nuevas.length, tareas_actualizadas: salida.cambios.tareas_estado.length };
    },

    async f4(ctx) {
      const abiertas = await filas(`select * from ${fn('f4_tareas_abiertas')}()`);
      if (!abiertas.length) return { tareas: 0 };
      const [salida] = await f4.procesar(abiertas, ctx);
      if (salida) await registrarCambios(salida.cambios);
      return { tareas: abiertas.length, actualizadas: salida ? salida.cambios.tareas_estado.length : 0, nuevas: salida ? salida.cambios.tareas_nuevas.length : 0 };
    },

    async f5(ctx) {
      const datos = await filas(`select ${fn('f5_datos')}() as datos`);
      return { resumenes: await f5.resumir(datos, ctx) };
    },
  };
}

module.exports = { crearOrquestador };
