import { createClient } from "npm:@supabase/supabase-js@2";

const NEGATIVE = ["空盒", "故障", "維修", "零件機", "徵收", "收購", "訂金", "租賃", "散熱器", "水冷頭", "背板"];
const NEW_ONLY = ["全新", "新品預購"];
const PRODUCTION_ORIGIN = "https://taurus850426-design.github.io";

function allowedOrigin(req: Request): string {
  const origin = req.headers.get("origin") || "";
  if (origin === PRODUCTION_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

function reply(body: Record<string, unknown>, status = 200, origin = "") {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
  } });
}

function numberPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch (_) { return ''; }
}

function classify(title: string, price: number, min: number, max: number, model: string, variant = "", condition = "") {
  const t = title.toLowerCase().replace(/core(?=i[3579])/g, 'core ');
  if (price < min || price > max) return { accepted: false, reason: "超出價格範圍" };
  if (NEGATIVE.some((x) => t.includes(x.toLowerCase()))) return { accepted: false, reason: "排除字詞" };
  if (NEW_ONLY.some((x) => t.includes(x.toLowerCase()))) return { accepted: false, reason: "全新商品" };
  const wanted = model.toLowerCase().replace(/[^a-z0-9]+/g, "");
  // Keep clock speeds separate from model suffixes instead of stripping all spaces.
  const models = (t.match(/(?:\bi[3579][\s-]*\d{4,5}[a-z]*\b|\bryzen\s*[3579][\s-]*\d{4}[a-z]*\b|\b(?:rtx|gtx|rx)[\s-]*\d{3,4}(?:\s*(?:ti|super|xtx|xt)\b)?)/g) || [])
    .map((value) => value.replace(/[^a-z0-9]+/g, ''));
  if (!models.includes(wanted) || models.some((value) => value !== wanted)) return { accepted: false, reason: "型號不符或多型號商品" };
  const memory = t.match(/\b(\d+)\s*gb\b/i);
  if (variant && memory && memory[1] + "GB" !== variant.toUpperCase()) return { accepted: false, reason: "規格不符" };
  if (/整機|主機|desktop|gaming\s*pc/i.test(t)) return { accepted: false, reason: "疑似整機" };
  const state = condition.toLowerCase().trim();
  if (/全新|新品|\bnew\b/.test(t + ' ' + state)) return { accepted: false, reason: "全新商品" };
  if (/未使用|非二手|非中古|翻新|整新|refurbished|renewed|for parts|not working/i.test(t + ' ' + state)) return { accepted: false, reason: "非一般二手品" };
  if (!/二手|中古|已使用|\bused\b|pre[ -]?owned|second[ -]?hand/i.test(t + ' ' + state)) return { accepted: false, reason: "未確認二手狀態" };
  return { accepted: true, reason: "" };
}

Deno.serve(async (req) => {
  const origin = allowedOrigin(req);
  if (req.method === "OPTIONS") return new Response(null, { status: origin ? 204 : 403, headers: origin ? {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "Origin",
  } : {} });
  if (!origin) return reply({ ok: false, code: "INVALID_ORIGIN" }, 403);
  if (req.method !== "POST") return reply({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405, origin);
  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const apiKey = Deno.env.get("SERPAPI_API_KEY") || "";
  if (!url || !anon || !service) return reply({ ok: false, code: "SERVER_CONFIG" }, 500, origin);

  const auth = req.headers.get("authorization") || "";
  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData.user) return reply({ ok: false, code: "UNAUTHORIZED" }, 401, origin);
  const { data: isAdmin, error: adminError } = await userClient.rpc("is_admin");
  if (adminError || isAdmin !== true) return reply({ ok: false, code: "FORBIDDEN" }, 403, origin);
  if (!apiKey) return reply({ ok: false, code: "API_KEY_MISSING", message: "尚未設定 SERPAPI_API_KEY" }, 503, origin);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const admin = createClient(url, service);
  let q = admin.from("used_market_watchlist").select("*").eq("enabled", true).order("category").order("model");
  if (body.watchlist_id) q = q.eq("id", String(body.watchlist_id));
  else q = q.limit(Math.min(Math.max(Number(body.limit) || 5, 1), 20));
  const { data: watchlist, error: watchError } = await q;
  if (watchError) return reply({ ok: false, code: "DATABASE_ERROR" }, 500, origin);

  let inserted = 0;
  const runs: Record<string, unknown>[] = [];
  for (const item of watchlist || []) {
    try {
    const params = new URLSearchParams({ engine: "google_shopping", google_domain: "google.com.tw", gl: "tw", hl: "zh-tw", q: item.search_query, api_key: apiKey });
    const response = await fetch("https://serpapi.com/search.json?" + params.toString(), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) { runs.push({ id: item.id, model: item.model, ok: false, status: response.status }); continue; }
    const data = await response.json();
    if (data.error) { runs.push({ id: item.id, model: item.model, ok: false, code: "PROVIDER_ERROR" }); continue; }
    const rows = Array.isArray(data.shopping_results) ? data.shopping_results.slice(0, 40) : [];
    const collectedAt = new Date().toISOString();
    const seen = new Set<string>();
    const payload = rows.flatMap((row: Record<string, unknown>) => {
      const price = numberPrice(row.extracted_price ?? row.price);
      const title = String(row.title || "").trim();
      const link = canonicalUrl(String(row.product_link || row.link || "").trim());
      if (!price || !title || !link) return [];
      if (seen.has(link)) return [];
      seen.add(link);
      const condition = String(row.second_hand_condition || '');
      const c = classify(title, price, Number(item.min_price), Number(item.max_price), String(item.model), String(item.variant || ""), condition);
      return [{ watchlist_id: item.id, provider: "SERPAPI_GOOGLE_SHOPPING", source_name: String(row.source || ""), title, price, item_url: link, condition_label: condition, accepted: c.accepted, reject_reason: c.reason, collected_at: collectedAt, raw_data: { rules_version: 2, position: row.position ?? null, delivery: row.delivery ?? null } }];
    });
    if (payload.length) {
      const { error } = await admin.from("used_market_observations").insert(payload);
      if (error) { runs.push({ id: item.id, model: item.model, ok: false, code: "INSERT_FAILED" }); continue; }
      inserted += payload.length;
    }
    runs.push({ id: item.id, model: item.model, ok: true, found: rows.length, saved: payload.length });
    } catch (_) {
      runs.push({ id: item.id, model: item.model, ok: false, code: "COLLECTION_FAILED" });
    }
  }
  return reply({ ok: true, models: runs.length, observations: inserted, runs }, 200, origin);
});
