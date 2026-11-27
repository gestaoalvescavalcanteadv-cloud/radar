// LitigaRadar - API publica de leitura (placares e decisoes). Nao grava nada.
// q = resumo | magistrados | orgaos | decisoes ; radar = bancario (padrao) | saude | previdenciario
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "public, max-age=300",
};
const RADARES = ["bancario", "saude", "previdenciario"];
const POR_PAGINA = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(req.url).searchParams;
  const q = u.get("q") || "resumo";
  const radar = RADARES.includes(u.get("radar") || "") ? u.get("radar")! : "bancario";
  const tema = u.get("tema") || null;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const resp = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { ...CORS, "content-type": "application/json" } });

  try {
    if (q === "resumo") {
      const { data, error } = await db.rpc("radar_resumo", { p_radar: radar });
      if (error) throw error;
      return resp(data);
    }
    if (q === "magistrados" || q === "orgaos") {
      const { data, error } = await db.rpc("radar_placar", { p_dim: q, p_tema: tema, p_radar: radar });
      if (error) throw error;
      return resp(data);
    }
    if (q === "decisoes") {
      const pagina = Math.max(0, Number(u.get("pagina") || 0));
      let s = db.from("radar_decisoes_publicas").select("*", { count: "exact" }).eq("radar", radar);
      if (tema) s = s.eq("tema", tema);
      if (u.get("magistrado_id")) s = s.eq("magistrado_id", Number(u.get("magistrado_id")));
      if (u.get("orgao_id")) s = s.eq("orgao_id", Number(u.get("orgao_id")));
      if (u.get("favoravel") === "true" || u.get("favoravel") === "false") s = s.eq("favoravel_consumidor", u.get("favoravel") === "true");
      const { data, count, error } = await s.order("data_disponibilizacao", { ascending: false }).order("id", { ascending: false })
        .range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
      if (error) throw error;
      return resp({ itens: data, total: count ?? 0, pagina });
    }
    return resp({ erro: "consulta desconhecida" }, 400);
  } catch (e) {
    return resp({ erro: String((e as any)?.message || e) }, 500);
  }
});
