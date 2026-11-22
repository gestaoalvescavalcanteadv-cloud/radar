// LitigaRadar - coleta do DJEN dos temas bancarios extras (veiculo, Serasa, golpes, superendividamento) - roda em Sao Paulo
// Parametros (JSON): tribunal, data (AAAA-MM-DD), paginaInicial, paginas, auto (true = continua de onde parou
// e grava o progresso em coleta_progresso_extra), gravar (padrao true), teste (true = so devolve amostras).
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";

// Temas bancarios extras: financiamento de veiculo, busca e apreensao, Serasa/divida prescrita, golpes/Pix, superendividamento
const TEMA = new RegExp([
  "financiamento de ve[ií]culo", "financiamento de autom[oó]vel", "ve[ií]culo automotor", "aliena[cç][aã]o fiduci",
  "busca e apreens", "Decreto-Lei n?\\.? ?911", "purga[cç][aã]o da mora", "tarifa de (avalia[cç][aã]o|registro|cadastro)",
  "registro (do|de) contrato", "servi[cç]os de terceiros", "seguro prestamista", "venda casada", "taxa m[eé]dia de mercado",
  "serasa", "limpa nome", "d[ií]vida prescrita", "prescri[cç][aã]o d[ae] (d[ií]vida|pretens[aã]o de cobran)",
  "superendividamento", "Lei n?\\.? ?14\\.181", "\\bpix\\b", "golpe", "fraude banc", "falsa central", "acesso remoto",
  "falso (advogado|funcion[aá]rio|gerente)", "transa[cç](ão|ões) n[aã]o reconhecid",
].join("|"), "i");
const PARTE = /\bbanco\b|financeira|cr[eé]dito|crefisa|crefaz|facta|agibank|aymor[eé]|omni|santander|ita[uú]|bradesco|caixa econ|nubank|serasa|recovery|ativos s|fidc|pagseguro|pagbank|mercado pago|picpay|stone|sicoob|sicredi|c6|inter\b|safra|volkswagen|toyota|honda|yamaha|porto seguro|losango|portocred|bv\b/i;
const EXCLUI = /criminal|j[uú]ri|penal|viol[eê]ncia dom|execu[cç][aã]o fiscal|sucess[oõ]es|registros p[uú]blicos|tr[aá]fico|fam[ií]lia|alimentos|uni[aã]o est[aá]vel|div[oó]rcio|invent[aá]rio|inf[aâ]ncia|fazenda p[uú]blica|trabalh/i;
const DISPOSITIVO = /julgo (totalmente |parcialmente )?(im)?procedente|julgo extint|dou( parcial)? provimento|nego provimento|conhe[cç]o .{0,60}provimento|homologo|(defiro|indefiro)[^.]{0,80}(tutela|liminar|antecipa[cç][aã]o)|(concedo|denego)[^.]{0,60}(tutela|liminar|seguran[cç]a)|(deferi|indeferi)mento da (tutela|liminar)/i;
const TITULO = /^\s*(Ju[ií]z[a]?( de Direito| Substitut[oa]| Titular| Auxiliar| Federal)?|Desembargador[a]?( Federal)?( Relator[a]?)?|Relator[a]?)\b(.*)$/i;
const NOME = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç']+( (d[aeo]s?|e|[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'.]+)){1,7}$/;

const limpa = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ");
const pega = (x: any, ...ks: string[]) => { for (const k of ks) if (x?.[k] != null && x[k] !== "") return x[k]; return null; };

function magistrado(texto: string): { nome: string; cargo: string } | null {
  const linhas = texto.split(/\r?\n/).map((l) => limpa(l).trim()).filter(Boolean);
  for (let i = linhas.length - 1; i >= Math.max(0, linhas.length - 40); i--) {
    const m = linhas[i].match(TITULO);
    if (!m) continue;
    const cargo = m[0].replace(m[5] || "", "").trim();
    const resto = (m[5] || "").replace(/^[\s,:-]+/, "").trim();
    if (NOME.test(resto) && !/vara|comarca|juizado|c[aâ]mara|turma|federal/i.test(resto)) return { nome: resto, cargo };
    const ant = i > 0 ? linhas[i - 1] : "";
    if (NOME.test(ant) && !/vara|comarca|juizado|c[aâ]mara|poder|tribunal|turma/i.test(ant)) return { nome: ant, cargo };
  }
  return null;
}

function trechoDispositivo(t: string): string {
  const m = DISPOSITIVO.exec(t);
  if (!m) return t.slice(-600);
  const ini = Math.max(0, m.index - 250);
  return t.slice(ini, ini + 650).trim();
}

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  // no modo automatico (agendado) responde na hora e trabalha em segundo plano, como a coleta bancaria
  if (body.auto === true && !body.esperar) {
    EdgeRuntime.waitUntil(coletar(body).catch((e) => console.error("coleta extra", e)));
    return Response.json({ aceito: true });
  }
  return Response.json(await coletar(body));
});

async function coletar(body: any) {
  const t0 = Date.now();
  const tribunal = String(body.tribunal || "TJCE").toUpperCase();
  const ontem = new Date(Date.now() - 86400000 - 3 * 3600000).toISOString().slice(0, 10);
  const data = String(body.data || ontem);
  const auto = body.auto === true;
  const gravar = body.gravar !== false && !body.teste;
  const maxPag = Math.min(Number(body.paginas || 120), 400);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let pagina = Number(body.paginaInicial || 1);
  if (auto) {
    const { data: p } = await db.from("coleta_progresso_extra").select("*").eq("tribunal", tribunal).eq("data", data).maybeSingle();
    if (p?.concluido) return { tribunal, data, ja_concluido: true };
    if (p?.proxima_pagina) pagina = p.proxima_pagina;
  }

  const orgCache = new Map<string, number>(), magCache = new Map<string, number>();
  async function orgaoId(nome: string | null) {
    if (!nome) return null;
    if (orgCache.has(nome)) return orgCache.get(nome)!;
    await db.from("orgaos").upsert({ tribunal, nome }, { onConflict: "tribunal,nome", ignoreDuplicates: true });
    const { data: o } = await db.from("orgaos").select("id").eq("tribunal", tribunal).eq("nome", nome).maybeSingle();
    if (o) orgCache.set(nome, o.id);
    return o?.id ?? null;
  }
  async function magistradoId(m: { nome: string; cargo: string } | null) {
    if (!m) return null;
    const nome = m.nome.toUpperCase();
    if (magCache.has(nome)) return magCache.get(nome)!;
    await db.from("magistrados").upsert({ tribunal, nome, cargo: m.cargo }, { onConflict: "nome,tribunal", ignoreDuplicates: true });
    const { data: o } = await db.from("magistrados").select("id").eq("tribunal", tribunal).eq("nome", nome).maybeSingle();
    if (o) magCache.set(nome, o.id);
    return o?.id ?? null;
  }

  let candidatas = 0, lidas = 0, gravadas = 0, ultimo = "", fim = false, feitas = 0;
  let base = { lidas: 0, gravadas: 0 };
  if (auto && gravar) {
    const { data: p } = await db.from("coleta_progresso_extra").select("lidas,gravadas").eq("tribunal", tribunal).eq("data", data).maybeSingle();
    if (p) base = { lidas: p.lidas || 0, gravadas: p.gravadas || 0 };
  }
  async function salvarProgresso() {
    if (!auto || !gravar) return;
    await db.from("coleta_progresso_extra").upsert({
      tribunal, data, proxima_pagina: pagina, concluido: fim, lidas: base.lidas + lidas,
      gravadas: base.gravadas + gravadas, ultimo_status: ultimo, atualizado_em: new Date().toISOString(),
    }, { onConflict: "tribunal,data" });
  }
  const amostras: any[] = [];
  const vistos = new Set<string>();
  while (feitas < maxPag && Date.now() - t0 < 115000) {
    const u = BASE + "?siglaTribunal=" + tribunal + "&dataDisponibilizacaoInicio=" + data + "&dataDisponibilizacaoFim=" + data +
      "&pagina=" + pagina + "&itensPorPagina=100";
    let r: Response | null = null;
    for (let tent = 0; tent < 3; tent++) {
      r = await fetch(u, { headers: { accept: "application/json" } }).catch(() => null);
      if (r && r.status !== 429 && r.status < 500) break;
      await new Promise((ok) => setTimeout(ok, 2500 * (tent + 1)));
    }
    ultimo = String(r?.status ?? "falha");
    if (!r || !r.ok) { await salvarProgresso(); break; }
    const b = await r.json().catch(() => ({}));
    const itens: any[] = b.items || b.itens || [];
    lidas += itens.length;
    feitas++;

    const linhas: any[] = [];
    for (const x of itens) {
      const texto = String(pega(x, "texto") || "");
      const orgao = pega(x, "nomeOrgao", "nome_orgao");
      const classe = pega(x, "nomeClasse", "nome_classe");
      const tipo = pega(x, "tipoDocumento", "tipo_documento");
      const cabeca = [orgao, classe].join(" ");
      if (EXCLUI.test(cabeca)) continue;
      const t = limpa(texto);
      if (!TEMA.test(t) || !PARTE.test(t) || !DISPOSITIVO.test(t)) continue;
      const processo = pega(x, "numeroprocessocommascara", "numero_processo", "numeroProcesso");
      const trecho = trechoDispositivo(t);
      const chave = await sha("extra|" + processo + "|" + trecho.replace(/\s+/g, " ").slice(0, 400));
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      candidatas++;
      // a coleta bancaria principal ja pode ter gravado a mesma decisao (outra intimacao do mesmo ato)
      if (!body.teste) {
        const { data: ja } = await db.from("decisoes").select("id").eq("numero_processo", processo).eq("data_disponibilizacao", String(pega(x, "data_disponibilizacao", "datadisponibilizacao") || data).slice(0, 10)).eq("radar", "bancario").limit(1);
        if (ja && ja.length) continue;
      }
      if (body.teste) { if (amostras.length < 5) amostras.push({ processo, orgao, classe, tipo, trecho: trecho.slice(0, 300), mag: magistrado(texto) }); continue; }
      linhas.push({
        radar: "bancario", djen_id: pega(x, "id"), tribunal, numero_processo: processo,
        data_disponibilizacao: String(pega(x, "data_disponibilizacao", "datadisponibilizacao") || data).slice(0, 10),
        orgao_id: await orgaoId(orgao), magistrado_id: await magistradoId(magistrado(texto)),
        tipo_documento: tipo, classe, trecho, texto: t.slice(0, 60000), link: pega(x, "link"), chave, ficha_status: "fila_extra",
      });
    }
    if (gravar && linhas.length) {
      const { error } = await db.from("decisoes").upsert(linhas, { onConflict: "chave", ignoreDuplicates: true });
      if (error) {
        for (const l of linhas) {
          const { error: e2 } = await db.from("decisoes").upsert(l, { onConflict: "chave", ignoreDuplicates: true });
          if (!e2) gravadas++;
        }
      } else gravadas += linhas.length;
    }
    if (body.teste && feitas === 1) amostras.unshift({ campos: Object.keys(itens[0] || {}) });
    pagina++;
    if (itens.length < 100) fim = true;
    await salvarProgresso();
    if (fim) break;
  }

  return { tribunal, data, paginas: feitas, proxima_pagina: pagina, concluido: fim, lidas, candidatas, gravadas, status: ultimo, amostras };
}
