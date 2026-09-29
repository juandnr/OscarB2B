-- Revisión manual del modo sombra de F2.
-- Criterio de "listo": clasificación correcta en ≥ 90 % de una muestra revisada a mano.

-- 1. Muestra aleatoria de 50 análisis de la última semana, con la conversación
--    que vio Claude (últimos 40 mensajes al momento del análisis).
select a.id,
       a.creado_at,
       coalesce(c.nombre_wa, a.telefono) as cliente,
       a.etapa_antes,
       a.etapa_detectada,
       a.confianza,
       a.resultado ->> 'motivo'  as motivo,
       a.resultado ->> 'resumen' as resumen,
       a.decision -> 'tareas'    as tareas_sugeridas,
       (select string_agg(to_char(m.ts at time zone 'America/Caracas', 'DD/MM HH24:MI') || ' '
                          || case m.direccion when 'entrante' then 'CLIENTE' else 'VENDEDOR' end
                          || ': ' || coalesce(m.texto, '[' || m.tipo || ']'), E'\n' order by m.ts)
          from (select * from mensajes m2
                where m2.telefono = a.telefono and m2.ts <= a.creado_at
                order by m2.ts desc limit 40) m) as conversacion
from analisis a
left join clientes c on c.telefono = a.telefono
where a.error is null
  and a.creado_at > now() - interval '7 days'
  and a.revision_correcta is null
order by random()
limit 50;

-- 2. Marcar cada análisis revisado:
--   update analisis set revision_correcta = true  where id = 123;
--   update analisis set revision_correcta = false, revision_nota = 'era cotizado, no solicitud' where id = 124;

-- 3. Precisión de lo revisado.
select count(*) filter (where revision_correcta)                          as correctos,
       count(*)                                                           as revisados,
       round(100.0 * count(*) filter (where revision_correcta) / nullif(count(*), 0), 1) as precision_pct
from analisis
where revision_correcta is not null;

-- 4. Errores más comunes (etapa detectada vs. nota del revisor).
select etapa_antes, etapa_detectada, count(*) as casos, string_agg(revision_nota, ' | ') as notas
from analisis
where revision_correcta = false
group by 1, 2
order by casos desc;

-- 5. Fallos de la API o de JSON en la última semana.
select date_trunc('day', creado_at) as dia, count(*) as errores, min(error) as ejemplo
from analisis
where error is not null and creado_at > now() - interval '7 days'
group by 1
order by 1;

-- 6. Consumo de tokens y caché del prompt (el system prompt debería leerse de caché).
select date_trunc('day', creado_at) as dia,
       count(*) as analisis,
       sum((tokens ->> 'input_tokens')::int)                as input,
       sum((tokens ->> 'cache_read_input_tokens')::int)     as cache_leido,
       sum((tokens ->> 'cache_creation_input_tokens')::int) as cache_escrito,
       sum((tokens ->> 'output_tokens')::int)               as output
from analisis
where tokens is not null and creado_at > now() - interval '7 days'
group by 1
order by 1;
