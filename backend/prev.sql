-- LitigaRadar: terceiro radar (Previdenciário / Justiça Federal) no mesmo banco
-- Fonte: DJEN do TRF5, só a 17ª, 25ª e 30ª Varas Federais do Ceará (processos .4.05.81xx), todos os assuntos.
-- Coleta: djen-coleta-prev (grava radar='previdenciario', ficha_status='fila_prev'); leitura: radar-ficha-prev.
create table if not exists public.coleta_progresso_prev (
  tribunal text not null, data date not null, proxima_pagina integer default 1, concluido boolean default false,
  lidas integer default 0, gravadas integer default 0, ultimo_status text, atualizado_em timestamptz default now(),
  primary key (tribunal, data)
);
alter table public.coleta_progresso_prev enable row level security;
grant select, insert, update, delete on public.coleta_progresso_prev to service_role;
create index if not exists decisoes_fila_prev on public.decisoes (id) where ficha_status = 'fila_prev';

-- resumo: rótulo do tribunal, fila de leitura e dias coletados do radar previdenciário
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
  'tribunal', case coalesce(p_radar, 'bancario') when 'saude' then 'TJCE e TRF5'
                when 'previdenciario' then 'TRF5 · 17ª, 25ª e 30ª Varas Federais do CE' else 'TJCE' end,
  'decisoes', a.decisoes, 'favoraveis', a.favoraveis, 'contrarias', a.contrarias, 'pct_favoravel', a.pct_favoravel,
  'dano_moral_qtd', a.dano_moral_qtd, 'dano_moral_medio', a.dano_moral_medio, 'magistrados', a.magistrados, 'orgaos', a.orgaos,
  'pendentes_ficha', (select count(*) from decisoes where radar = coalesce(p_radar, 'bancario')
                        and ficha_status is not distinct from (case coalesce(p_radar, 'bancario') when 'saude' then 'fila_saude'
                                                                 when 'previdenciario' then 'fila_prev' end)),
  'ultima_publicacao', (select max(data_disponibilizacao) from decisoes where radar = coalesce(p_radar, 'bancario')),
  'dias_coletados', case coalesce(p_radar, 'bancario')
                      when 'saude' then (select count(*) from coleta_progresso_saude where concluido)
                      when 'previdenciario' then (select count(*) from coleta_progresso_prev where concluido) end,
  'temas', (select coalesce(jsonb_agg(x order by x.total desc), '[]'::jsonb) from (select tema, total, favoraveis, contrarias from t) x)
) from a
$function$;

-- Coleta do histórico: o dia mais recente ainda não concluído do TRF5, últimos 182 dias
create or replace function public.radar_backfill_prev() returns text language plpgsql as $function$
declare alvo date; cmd text;
begin
  select dt::date into alvo
  from generate_series(current_date - 182, current_date - 1, interval '1 day') dt
  where not exists (select 1 from coleta_progresso_prev c where c.tribunal = 'TRF5' and c.data = dt::date and c.concluido)
  order by dt desc
  limit 1;
  if alvo is null then return 'historico previdenciario completo'; end if;
  if exists (select 1 from coleta_progresso_prev c where c.tribunal = 'TRF5' and c.data = alvo and c.atualizado_em > now() - interval '2 minutes') then
    return 'aguardando TRF5 ' || alvo;
  end if;
  cmd := (select command from cron.job where jobname = 'radar-coleta-tjce');
  cmd := regexp_replace(cmd, '/functions/v1/djen-coleta\y', '/functions/v1/djen-coleta-prev');
  cmd := replace(cmd, '{"tribunal":"TJCE","auto":true,"paginas":140}',
                 '{"tribunal":"TRF5","auto":true,"paginas":140,"data":"' || alvo || '"}');
  execute cmd;
  return 'coletando previdenciario TRF5 ' || alvo;
end $function$;

-- Ficha pela IA, dentro do mesmo teto diário de US$ 5 dos outros radares
create or replace function public.radar_backfill_ficha_prev() returns text language plpgsql as $function$
declare gasto numeric; cmd text;
begin
  select coalesce(sum(custo_usd), 0) into gasto from ia_consumo
   where criado_em >= date_trunc('day', now() at time zone 'America/Fortaleza') at time zone 'America/Fortaleza';
  if gasto >= 5 then return 'teto diario atingido: US$ ' || round(gasto, 2); end if;
  if not exists (select 1 from decisoes where ficha_status = 'fila_prev') then return 'nada pendente'; end if;
  cmd := (select command from cron.job where jobname = 'radar-ficha-ia');
  cmd := regexp_replace(cmd, '/functions/v1/radar-ficha\y', '/functions/v1/radar-ficha-prev');
  execute cmd;
  return 'ficha previdenciario disparada (gasto hoje US$ ' || round(gasto, 2) || ')';
end $function$;

-- agendamentos (ritmo lento, nos minutos livres): radar-prev-coleta 6-59/10 · radar-prev-ficha 9-59/10
select cron.schedule('radar-prev-coleta', '6-59/10 * * * *', 'select public.radar_backfill_prev()');
select cron.schedule('radar-prev-ficha', '9-59/10 * * * *', 'select public.radar_backfill_ficha_prev()');
