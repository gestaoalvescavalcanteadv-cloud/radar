-- LitigaRadar: segundo radar (Saúde e direitos do autista) no mesmo banco
alter table public.decisoes add column if not exists radar text not null default 'bancario';
create index if not exists decisoes_radar_tema on public.decisoes (radar, tema);
create index if not exists decisoes_fila_saude on public.decisoes (id) where ficha_status = 'fila_saude';

create table if not exists public.coleta_progresso_saude (
  tribunal text not null, data date not null, proxima_pagina integer default 1, concluido boolean default false,
  lidas integer default 0, gravadas integer default 0, ultimo_status text, atualizado_em timestamptz default now(),
  primary key (tribunal, data)
);
alter table public.coleta_progresso_saude enable row level security;
grant select, insert, update, delete on public.coleta_progresso_saude to service_role;

-- view pública passa a mostrar o radar de cada decisão (coluna nova no fim)
create or replace view public.radar_decisoes_publicas as
SELECT d.id, d.tribunal, d.numero_processo, d.data_disponibilizacao, d.tipo_documento, d.tema, d.resultado, d.favoravel_consumidor,
  d.dano_moral_concedido, d.dano_moral_valor, d.repeticao_dobro, d.tese, d.link, d.orgao_id, d.magistrado_id,
  CASE WHEN d.orgao_id IS NOT NULL THEN jsonb_build_object('id', o.id, 'nome', o.nome) ELSE NULL::jsonb END AS orgaos,
  CASE WHEN radar_nome_ok(m.nome) THEN jsonb_build_object('id', m.id, 'nome', radar_nome_limpo(m.nome)) ELSE NULL::jsonb END AS magistrados,
  d.radar, d.subtema
FROM decisoes d LEFT JOIN orgaos o ON o.id = d.orgao_id LEFT JOIN magistrados m ON m.id = d.magistrado_id
WHERE d.ficha_status = 'ok'::text AND COALESCE(d.relevante, true) AND (d.confianca = ANY (ARRAY['alta'::text, 'media'::text]));

-- placar por magistrado/órgão, agora por radar (padrão: bancário, para nada mudar no que já existe)
drop function if exists public.radar_placar(text, text);
create or replace function public.radar_placar(p_dim text, p_tema text default null, p_radar text default 'bancario')
RETURNS TABLE(id bigint, nome text, tribunal text, total bigint, favoraveis bigint, contrarias bigint, pct_favoravel numeric,
  dano_moral bigint, dano_moral_medio numeric, temas jsonb, amostra_pequena boolean)
LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
with b as (
  select (case when p_dim = 'orgaos' then d.orgao_id else d.magistrado_id end)::bigint as eid, d.tema, d.favoravel_consumidor,
    d.dano_moral_concedido, d.dano_moral_valor
  from decisoes d
  where d.ficha_status = 'ok' and coalesce(d.relevante, true) and d.confianca in ('alta','media')
    and d.radar = coalesce(p_radar, 'bancario') and (p_tema is null or d.tema = p_tema)
), g as (
  select eid, count(*) total, count(*) filter (where favoravel_consumidor) fav, count(*) filter (where favoravel_consumidor = false) contra,
    count(*) filter (where dano_moral_concedido) dm, avg(dano_moral_valor) filter (where dano_moral_concedido and dano_moral_valor > 0) dmm
  from b where eid is not null group by eid
), t as (
  select eid, jsonb_object_agg(tema, n) temas
  from (select eid, coalesce(tema, 'Sem tema') tema, count(*) n from b where eid is not null group by 1, 2) x group by eid
), e as (
  select m.id::bigint eid, radar_nome_limpo(m.nome) nome, m.tribunal::text tribunal from magistrados m where p_dim <> 'orgaos' and radar_nome_ok(m.nome)
  union all
  select o.id::bigint, o.nome::text, o.tribunal::text from orgaos o where p_dim = 'orgaos'
)
select g.eid, e.nome, e.tribunal, g.total, g.fav, g.contra,
  case when g.fav + g.contra > 0 then round(100.0 * g.fav / (g.fav + g.contra), 1) end,
  g.dm, round(g.dmm), t.temas, (g.fav + g.contra) < 10
from g join t using (eid) join e using (eid) order by g.total desc
$function$;

drop function if exists public.radar_resumo();
create or replace function public.radar_resumo(p_radar text default 'bancario') RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
with b as (
  select favoravel_consumidor, dano_moral_concedido, dano_moral_valor, magistrado_id, orgao_id, tema, tribunal
  from decisoes
  where ficha_status = 'ok' and coalesce(relevante, true) and confianca in ('alta','media') and radar = coalesce(p_radar, 'bancario')
), a as (
  select count(*) decisoes, count(*) filter (where favoravel_consumidor) favoraveis, count(*) filter (where favoravel_consumidor = false) contrarias,
    round(100.0 * count(*) filter (where favoravel_consumidor) / nullif(count(*) filter (where favoravel_consumidor is not null), 0), 1) pct_favoravel,
    count(*) filter (where dano_moral_concedido) dano_moral_qtd,
    round(avg(dano_moral_valor) filter (where dano_moral_concedido and dano_moral_valor > 0)) dano_moral_medio,
    count(distinct magistrado_id) magistrados, count(distinct orgao_id) orgaos
  from b
), t as (
  select coalesce(tema, 'Sem tema') tema, count(*) total, count(*) filter (where favoravel_consumidor) favoraveis,
    count(*) filter (where favoravel_consumidor = false) contrarias
  from b group by 1
)
select jsonb_build_object(
  'radar', coalesce(p_radar, 'bancario'),
  'tribunal', case when coalesce(p_radar, 'bancario') = 'saude' then 'TJCE e TRF5' else 'TJCE' end,
  'decisoes', a.decisoes, 'favoraveis', a.favoraveis, 'contrarias', a.contrarias, 'pct_favoravel', a.pct_favoravel,
  'dano_moral_qtd', a.dano_moral_qtd, 'dano_moral_medio', a.dano_moral_medio, 'magistrados', a.magistrados, 'orgaos', a.orgaos,
  'pendentes_ficha', (select count(*) from decisoes where radar = coalesce(p_radar, 'bancario')
                        and ficha_status is not distinct from (case when coalesce(p_radar, 'bancario') = 'saude' then 'fila_saude' end)),
  'ultima_publicacao', (select max(data_disponibilizacao) from decisoes where radar = coalesce(p_radar, 'bancario')),
  'dias_coletados', case when coalesce(p_radar, 'bancario') = 'saude'
                      then (select count(*) from coleta_progresso_saude where concluido) end,
  'temas', (select coalesce(jsonb_agg(x order by x.total desc), '[]'::jsonb) from (select tema, total, favoraveis, contrarias from t) x)
) from a
$function$;

-- Coleta do histórico de saúde: o dia mais recente ainda não concluído (TJCE primeiro, depois TRF5), últimos 182 dias
create or replace function public.radar_backfill_saude() returns text language plpgsql as $function$
declare alvo date; trib text; cmd text;
begin
  select x.dt, x.tr into alvo, trib
  from (select dt::date dt, tr, ordem from generate_series(current_date - 182, current_date - 1, interval '1 day') dt,
        unnest(array['TJCE','TRF5']) with ordinality as u(tr, ordem)) x
  where not exists (select 1 from coleta_progresso_saude c where c.tribunal = x.tr and c.data = x.dt and c.concluido)
  order by x.ordem, x.dt desc
  limit 1;
  if alvo is null then return 'historico de saude completo'; end if;
  if exists (select 1 from coleta_progresso_saude c where c.tribunal = trib and c.data = alvo and c.atualizado_em > now() - interval '2 minutes') then
    return 'aguardando ' || trib || ' ' || alvo;
  end if;
  cmd := (select command from cron.job where jobname = 'radar-coleta-tjce');
  cmd := regexp_replace(cmd, '/functions/v1/djen-coleta\y', '/functions/v1/djen-coleta-saude');
  cmd := replace(cmd, '{"tribunal":"TJCE","auto":true,"paginas":140}',
                 '{"tribunal":"' || trib || '","auto":true,"paginas":140,"data":"' || alvo || '"}');
  execute cmd;
  return 'coletando saude ' || trib || ' ' || alvo;
end $function$;

-- Ficha pela IA do radar de saúde, dentro do mesmo teto diário de US$ 5 do radar bancário
create or replace function public.radar_backfill_ficha_saude() returns text language plpgsql as $function$
declare gasto numeric; cmd text;
begin
  select coalesce(sum(custo_usd), 0) into gasto from ia_consumo
   where criado_em >= date_trunc('day', now() at time zone 'America/Fortaleza') at time zone 'America/Fortaleza';
  if gasto >= 5 then return 'teto diario atingido: US$ ' || round(gasto, 2); end if;
  if not exists (select 1 from decisoes where ficha_status = 'fila_saude') then return 'nada pendente'; end if;
  cmd := (select command from cron.job where jobname = 'radar-ficha-ia');
  cmd := regexp_replace(cmd, '/functions/v1/radar-ficha\y', '/functions/v1/radar-ficha-saude');
  execute cmd;
  return 'ficha saude disparada (gasto hoje US$ ' || round(gasto, 2) || ')';
end $function$;

-- agendamentos
select cron.schedule('radar-saude-coleta', '*/2 * * * *', 'select public.radar_backfill_saude()');
select cron.schedule('radar-saude-ficha', '1-59/4 * * * *', 'select public.radar_backfill_ficha_saude()');
