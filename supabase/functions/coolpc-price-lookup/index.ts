/**
 * Manual CoolPC price lookup for the admin vendor quote form.
 * Fetches one official category page only after an authenticated admin click.
 * Results are candidates: the user must select an exact model before saving.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CacheEntry = { fetchedAt: number; html: string };
const pageCache = new Map<number, CacheEntry>();
const CACHE_MS = 4 * 60 * 60 * 1000;
const MAX_HTML_BYTES = 4_000_000;

const GROUP_BY_CATEGORY: Record<string, number> = {
  "處理器": 4,
  "cpu": 4,
  "主機板": 5,
  "記憶體": 6,
  "ram": 6,
  "硬碟": 7,
  "ssd": 7,
  "hdd": 7,
  "顯示卡": 12,
  "gpu": 12,
  "螢幕": 13,
  "顯示器": 13,
  "機殼": 14,
  "電源供應器": 15,
  "電源": 15,
  "psu": 15,
  "鍵盤": 17,
  "滑鼠": 17,
  "耳機": 17,
  "周邊": 17,
};

const CONDITIONAL_RULES: Array<[RegExp, string]> = [
  [/裝機價/i, "裝機價"],
  [/搭板|搭主機板/i, "搭板條件價"],
  [/任搭/i, "任搭條件價"],
  [/限組裝|限搭機|限搭/i, "限組裝／搭機"],
  [/組合價|組合包/i, "組合價"],
  [/活動價|現省/i, "活動條件價"],
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function env(name: string): string {
  return String(Deno.env.get(name) || "").trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (_all, key: string) => {
    const lower = String(key).toLowerCase();
    if (lower.startsWith("#x")) {
      const n = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    }
    if (lower.startsWith("#")) {
      const n = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    }
    return named[lower] || "";
  });
}

function htmlLines(html: string): string[] {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/td|\/li|\/option|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u00a0\s]+/g, " ").trim())
    .filter(Boolean);
}

function isProductTitle(line: string): boolean {
  if (/[｛{][^｝}]{2,}[｝}]/.test(line)) return true;
  if (/^(裝機價|\[搭板專案)/.test(line)) return true;
  return false;
}

function extractProducts(html: string): Array<{ title: string; price: number }> {
  const lines = htmlLines(html);
  const out: Array<{ title: string; price: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/含稅\s*[:：]\s*NT\$?\s*([\d,]+)/i);
    if (!match) continue;
    const price = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    let title = "";
    for (let j = i - 1; j >= Math.max(0, i - 24); j -= 1) {
      if (isProductTitle(lines[j])) {
        title = lines[j];
        break;
      }
      if (/含稅\s*[:：]/.test(lines[j])) break;
    }
    if (!title) continue;
    title = title.replace(/^Image\s*/i, "").trim();
    const key = title + "|" + price;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, price });
  }
  return out;
}

function normalizedTokens(value: string): string[] {
  return String(value || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/([A-Z])-(\d)/g, "$1$2")
    .replace(/(\d)-(\d)/g, "$1$2")
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length >= 2)
    .filter((token) => !["REV", "VER", "VERSION"].includes(token));
}

function scoreTitle(query: string, title: string): number {
  const qTokens = Array.from(new Set(normalizedTokens(query)));
  const t = " " + normalizedTokens(title).join(" ") + " ";
  if (!qTokens.length) return 0;
  let matched = 0;
  let importantMatched = 0;
  let importantTotal = 0;
  for (const token of qTokens) {
    const important = /[A-Z]+\d|\d+[A-Z]|DDR\d|GB|TB/.test(token);
    if (important) importantTotal += 1;
    if (t.includes(" " + token + " ")) {
      matched += important ? 2 : 1;
      if (important) importantMatched += 1;
    }
  }
  const denominator = qTokens.reduce((sum, token) => sum + (/[A-Z]+\d|\d+[A-Z]|DDR\d|GB|TB/.test(token) ? 2 : 1), 0);
  let score = denominator ? matched / denominator : 0;
  if (importantTotal && importantMatched === importantTotal) score += 0.2;
  const compactQuery = normalizedTokens(query).join("");
  const compactTitle = normalizedTokens(title).join("");
  if (compactQuery.length >= 5 && compactTitle.includes(compactQuery)) score += 0.25;
  return Math.min(1, score);
}

function conditionForTitle(title: string): { eligible: boolean; reason: string } {
  for (const [rule, reason] of CONDITIONAL_RULES) {
    if (rule.test(title)) return { eligible: false, reason };
  }
  return { eligible: true, reason: "正常單品含稅價候選" };
}

async function fetchCategoryPage(group: number): Promise<{ html: string; cached: boolean }> {
  const hit = pageCache.get(group);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) {
    return { html: hit.html, cached: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("https://www.coolpc.com.tw/eachview.php?IGrp=" + group, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-TW,zh;q=0.9",
        "User-Agent": "DKComputer-Admin-PriceLookup/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("CoolPC HTTP " + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_HTML_BYTES) throw new Error("CoolPC page too large");
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    let charset = contentType.includes("big5") ? "big5" : "utf-8";
    let html = new TextDecoder(charset).decode(bytes);
    const badRatio = (html.match(/�/g) || []).length / Math.max(1, html.length);
    if (charset === "utf-8" && badRatio > 0.002) {
      charset = "big5";
      html = new TextDecoder(charset).decode(bytes);
    }
    pageCache.set(group, { fetchedAt: Date.now(), html });
    return { html, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
  if (!supabaseUrl || !anonKey) {
    return json({ ok: false, code: "edge_misconfigured", error: "查價服務尚未完成設定" }, 500);
  }
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ ok: false, error: "not authenticated" }, 401);
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user?.id) {
    return json({ ok: false, error: "not authenticated" }, 401);
  }
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role,enabled")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile || profile.enabled !== true || String(profile.role) !== "admin") {
    return json({ ok: false, error: "admin only" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, code: "invalid_json", error: "請求格式不正確" }, 400);
  }
  const query = String(body.query || "").trim().slice(0, 120);
  const category = String(body.category || "").trim().slice(0, 30);
  if (!query) return json({ ok: false, code: "missing_query", error: "請先填品牌／型號／規格" }, 400);
  if (!category) return json({ ok: false, code: "missing_category", error: "請先選擇品類" }, 400);

  const categoryKey = category.toLowerCase();
  const group = GROUP_BY_CATEGORY[category] || GROUP_BY_CATEGORY[categoryKey];
  if (!group) {
    return json({
      ok: false,
      code: "unsupported_category",
      error: "此品類目前無法自動查原價屋，請手動輸入行情價",
    }, 400);
  }

  const sourceUrl = "https://www.coolpc.com.tw/eachview.php?IGrp=" + group;
  try {
    const page = await fetchCategoryPage(group);
    const products = extractProducts(page.html);
    const candidates = products
      .map((product) => {
        const score = scoreTitle(query, product.title);
        const condition = conditionForTitle(product.title);
        return {
          title: product.title,
          price: product.price,
          score: Math.round(score * 100),
          eligible: condition.eligible,
          reason: condition.reason,
        };
      })
      .filter((candidate) => candidate.score >= 25)
      .sort((a, b) => b.score - a.score || Number(b.eligible) - Number(a.eligible) || a.price - b.price)
      .slice(0, 8);

    return json({
      ok: true,
      query,
      category,
      source_url: sourceUrl,
      checked_at: new Date().toISOString(),
      cached: page.cached,
      candidates,
      product_count: products.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return json({
      ok: false,
      code: "source_unavailable",
      error: "目前無法取得原價屋行情，請稍後再試或手動輸入",
      detail: message.slice(0, 160),
    }, 502);
  }
});
