// LitigaRadar - ficha pela IA das decisoes do radar PREVIDENCIARIO / JUSTICA FEDERAL (17a, 25a e 30a Varas Federais do CE)
// Pega as decisoes com ficha_status = 'fila_prev', le com o Claude e grava tema, resultado e tese.
// Parametros (JSON): lote (padrao 40), paralelo (padrao 8)
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODELO = "claude-haiku-5-5";
const PRECO_ENTRADA = 0.10 / 1e6, PRECO_SAIDA = 0.50 / 1e6;   // US$ por token (mesmo calculo da ficha bancaria)

const TEMAS = [
  "Aposentadoria por idade rural",
  "Aposentadoria por idade urbana",
  "Aposentadoria por tempo de contribuição ou especial",
  "Aposentadoria da pessoa com deficiência",
  "Benefício por incapacidade (auxílio-doença e invalidez)",
  "Auxílio-acidente",
  "BPC/LOAS à pessoa com deficiência",
  "BPC/LOAS ao idoso",
  "Pensão por morte",
  "Salário-maternidade",
  "Auxílio-reclusão",
  "Revisão de benefício",
  "Descontos indevidos no benefício",
  "Outros previdenciários",
  "Caixa, FGTS e habitação",
  "Servidor público federal",
  "Saúde contra a União",
  "Tributário e conselhos profissionais",
  "Criminal",
  "Outros assuntos",
];
const OUTROS = "Outros assuntos";

const SISTEMA = [
  "Você lê publicações oficiais do Diário de Justiça (DJEN) de Varas Federais do Ceará (TRF5) e preenche uma ficha sobre a decisão judicial publicada.",
  "Responda SOMENTE com um objeto JSON, sem texto antes ou depois, com estas chaves:",
  "- relevante (boolean): true só se o texto traz uma DECISÃO com resultado (sentença, acórdão, decisão de tutela/liminar, homologação de acordo, embargos de declaração julgados). Despachos de mero expediente, citações, intimações para perícia ou para falar nos autos e atos ordinatórios = false.",
  "- tema (string): exatamente um destes: " + TEMAS.join(" | ") + ". Use 'Descontos indevidos no benefício' para descontos de associações, sindicatos ou empréstimos no benefício do INSS. Assuntos que não são previdenciários vão para o tema não previdenciário que couber; se nenhum couber, 'Outros assuntos'.",
  "- subtema (string curta com o ponto decisivo, ex.: 'qualidade de segurado especial não comprovada', 'laudo pericial atesta incapacidade', 'renda per capita acima de 1/4', 'tempo especial por ruído', 'carência não cumprida').",
  "- resultado (string): um destes: procedente | parcialmente procedente | improcedente | tutela deferida | tutela indeferida | provido | parcialmente provido | desprovido | acordo | extinto | outro.",
  "- polo_consumidor (string): 'autor' se o segurado/cidadão (pessoa física que pede o benefício ou o direito) é autor/recorrente; 'reu' se é réu/recorrido; 'indefinido'.",
  "- favoravel_consumidor (boolean ou null): true se o resultado final favorece o segurado/cidadão contra o INSS, a União, a Caixa ou outro ente (concede ou restabelece o benefício, reconhece o direito, nega recurso do INSS); false se nega o pedido ou retira o direito; null se acordo, extinção sem mérito, matéria criminal ou impossível saber.",
  "- dano_moral_concedido (boolean): true só se fixou indenização por dano moral em favor do segurado/cidadão.",
  "- dano_moral_valor (number ou null): valor do dano moral em reais, se fixado.",
  "- tese (string até 300 caracteres): o fundamento central em linguagem simples, ex.: 'Início de prova material (CAF e certidão de casamento) corroborado por prova testemunhal comprova o labor rural na carência.'",
  "- confianca (string): alta | media | baixa.",
  "- magistrado (string ou null): nome do juiz que assina, se aparecer.",
].join("\n");

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  // agendado: responde na hora e le em segundo plano; com "esperar": true devolve o resultado
  if (!body.esperar) {
    EdgeRuntime.waitUntil(fichar(body).catch((e) => console.error("ficha prev", e)));
    return Response.json({ aceito: true });
  }
  return Response.json(await fichar(body));
});

async function fichar(body: any) {
  const lote = Math.min(Number(body.lote || 40), 120), paralelo = Math.min(Number(body.paralelo || 3), 8);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const chave = Deno.env.get("ANTHROPIC_API_KEY")!;

  const { data: fila } = await db.from("decisoes").select("id,texto,trecho,classe,tipo_documento,tribunal,magistrado_id")
    .eq("ficha_status", "fila_prev").order("data_disponibilizacao", { ascending: false }).limit(lote);
  let ok = 0, erro = 0, pulou = 0;

  async function ler(d: any) {
    const texto = String(d.texto || d.trecho || "");
    const corte = texto.length > 14000 ? texto.slice(0, 5000) + "\n[...]\n" + texto.slice(-9000) : texto;
    try {
      let r: Response | null = null;
      for (let tent = 0; tent < 4; tent++) {
        r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: MODELO, max_tokens: 1500, system: SISTEMA,
            messages: [{ role: "user", content: "Classe: " + (d.classe || "-") + "\nTipo: " + (d.tipo_documento || "-") + "\n\n" + corte }] }),
        }).catch(() => null);
        if (r && r.ok) break;
        if (r && r.status < 500 && r.status !== 429) break;
        await new Promise((ok) => setTimeout(ok, 3000 * (tent + 1) + Math.random() * 2000));
      }
      // IA ocupada ou fora do ar: devolve para a fila e tenta na proxima rodada
      if (!r || r.status === 429 || r.status >= 500) { pulou++; return; }
      if (!r.ok) throw new Error("IA " + r.status);
      const j = await r.json();
      const txt = (j.content || []).map((c: any) => c.text || "").join("");
      const ini = txt.indexOf("{"), fimJ = txt.lastIndexOf("}");
      if (ini < 0 || fimJ <= ini) throw new Error("sem JSON: parada=" + j.stop_reason + " tipos=" + (j.content || []).map((c: any) => c.type).join(",") + " inicio=" + txt.slice(0, 120));
      const f = JSON.parse(txt.slice(ini, fimJ + 1));
      const tema = TEMAS.includes(f.tema) ? f.tema : OUTROS;
      const upd: any = {
        relevante: !!f.relevante, tema, subtema: f.subtema ? String(f.subtema).slice(0, 120) : null,
        resultado: f.resultado || null, polo_consumidor: f.polo_consumidor || null,
        favoravel_consumidor: typeof f.favoravel_consumidor === "boolean" ? f.favoravel_consumidor : null,
        dano_moral_concedido: !!f.dano_moral_concedido,
        dano_moral_valor: Number(f.dano_moral_valor) > 0 ? Number(f.dano_moral_valor) : null,
        tese: f.tese ? String(f.tese).slice(0, 400) : null, confianca: ["alta", "media", "baixa"].includes(f.confianca) ? f.confianca : "baixa",
        ficha_status: "ok", ficha_em: new Date().toISOString(), ficha_modelo: MODELO,
        texto: null,   // texto integral nao fica guardado depois de lido (o link oficial continua)
      };
      // juiz que a leitura automatica do texto nao achou: usa o nome que a IA leu na assinatura
      const nomeMag = typeof f.magistrado === "string" ? f.magistrado.replace(/^(ju[ií]z[a]?|desembargador[a]?|relator[a]?)( de direito| federal| substitut[oa])?[\s,:-]*/i, "").trim().toUpperCase() : "";
      if (!d.magistrado_id && nomeMag.length >= 8 && nomeMag.split(" ").length >= 2 && nomeMag.length <= 80) {
        await db.from("magistrados").upsert({ tribunal: d.tribunal, nome: nomeMag }, { onConflict: "nome,tribunal", ignoreDuplicates: true });
        const { data: m } = await db.from("magistrados").select("id").eq("tribunal", d.tribunal).eq("nome", nomeMag).maybeSingle();
        if (m) upd.magistrado_id = m.id;
      }
      await db.from("decisoes").update(upd).eq("id", d.id);
      const u = j.usage || {};
      await db.from("ia_consumo").insert({ decisao_id: d.id, modelo: MODELO, tokens_entrada: u.input_tokens || 0,
        tokens_saida: u.output_tokens || 0, custo_usd: (u.input_tokens || 0) * PRECO_ENTRADA + (u.output_tokens || 0) * PRECO_SAIDA });
      ok++;
    } catch (e) {
      console.error("ficha prev", d.id, String(e));
      await db.from("decisoes").update({ ficha_status: "erro_prev", ficha_em: new Date().toISOString() }).eq("id", d.id);
      erro++;
    }
  }

  const lista = fila || [];
  for (let i = 0; i < lista.length; i += paralelo) await Promise.all(lista.slice(i, i + paralelo).map(ler));
  return { lidas: lista.length, ok, erro, pulou };
}
