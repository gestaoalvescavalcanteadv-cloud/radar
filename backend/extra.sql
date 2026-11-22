-- LitigaRadar: temas bancários extras (veículo, busca e apreensão, Serasa/dívida prescrita, golpes/Pix, superendividamento)
-- Coleta: djen-coleta-extra (grava radar='bancario', ficha_status='fila_extra'); leitura: radar-ficha-extra.
create table if not exists public.coleta_progresso_extra (
  tribunal text not null, data date not null, proxima_pagina integer default 1, concluido boolean default false,
  lidas integer default 0, gravadas integer default 0, ultimo_status text, atualizado_em timestamptz default now(),
  primary key (tribunal, data)
);
alter table public.coleta_progresso_extra enable row level security;
grant select, insert, update, delete on public.coleta_progresso_extra to service_role;
create index if not exists decisoes_fila_extra on public.decisoes (id) where ficha_status = 'fila_extra';
-- funções radar_backfill_extra() e radar_backfill_ficha_extra(): mesmo padrão de saude.sql (TJCE, 182 dias, teto US$ 5/dia)
-- ritmo lento para poupar a cota de disco (Nano):
-- radar-saude-coleta */10 · radar-saude-ficha 3-59/10 · radar-extra-coleta 5-59/10 · radar-extra-ficha 8-59/10
-- radar-historico-ficha 2-59/10 10-23,0-4
