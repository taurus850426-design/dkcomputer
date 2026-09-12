/**
 * Stage 05 public used-computer estimate.
 * Browser → this Edge Function (anon gateway)
 *   → service_used_valuation_rate_limit
 *   → service_used_valuation_public_estimate
 *   → dk_used_valuation_compute_v1
 * Formula stays in Postgres. Rate limit is DB fixed-window, not memory Map.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMPONENTS = 20;
const PRODUCTION_ORIGIN = "https://taurus850426-design.github.io";
const HASH_SEPARATOR = ":";
const ALLOWED_CATEGORIES = [
  "CPU",
  "GPU",
  "MOTHERBOARD",
  "RAM",
  "STORAGE",
  "PSU",
  "CASE",
  "COOLER",
  "LAPTOP",
  "OTHER",
];

const DTO_ESTIMATE_KEYS = [
  "market_low",
  "market_mid",
  "market_high",
  "value_score",
  "coverage_percent",
  "matched_count",
  "total_count",
  "market_updated_at",
  "reasons",
];

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function isAllowedOrigin(origin: string): boolean {
  const o = String(origin || "").trim();
  if (!o) return false;
  if (o === PRODUCTION_ORIGIN) return true;
  if (/^http:\/\/localhost(?::\d+)?$/.test(o)) return true;
  if (/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(o)) return true;
  return false;
}

function json(
  body: Record<string, unknown>,
  status: number,
  origin: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      ...(extraHeaders || {}),
    },
  });
}

function rejectUnknownOrigin(): Response {
  return new Response(JSON.stringify({ ok: false, code: "INVALID_REQUEST" }), {
    status: 403,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function firstEnv(names: string[]): string {
  for (const name of names) {
    const v = Deno.env.get(name);
    if (v == null) continue;
    const t = String(v).trim();
    if (!t) continue;
    if (t.startsWith("[")) {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item === "string" && item.trim()) return item.trim();
          }
        }
      } catch {
        /* fall through */
      }
    }
    return t;
  }
  return "";
}

function rateLimitSalt(): string {
  const v = Deno.env.get("USED_VALUATION_RATE_LIMIT_SALT");
  return v == null ? "" : String(v).trim();
}

function publicError(code: string): { ok: false; code: string } {
  return { ok: false, code };
}

function statusFor(code: string): number {
  if (code === "INVALID_REQUEST" || code === "TOO_MANY_COMPONENTS") return 400;
  if (code === "RATE_LIMITED") return 429;
  if (code === "INSUFFICIENT_MARKET_DATA") return 422;
  if (code === "NO_ACTIVE_MARKET" || code === "NO_ACTIVE_RULE") return 503;
  return 500;
}

function mapPublicCode(raw: string): string {
  const c = String(raw || "").trim();
  if (c === "INVALID_REQUEST") return "INVALID_REQUEST";
  if (c === "TOO_MANY_COMPONENTS") return "TOO_MANY_COMPONENTS";
  if (c === "NO_ACTIVE_MARKET" || c === "NO_ACTIVE_MARKET_BATCH") return "NO_ACTIVE_MARKET";
  if (c === "NO_ACTIVE_RULE" || c === "NO_ACTIVE_RULE_VERSION") return "NO_ACTIVE_RULE";
  if (c === "INSUFFICIENT_MARKET_DATA") return "INSUFFICIENT_MARKET_DATA";
  if (c === "RATE_LIMITED") return "RATE_LIMITED";
  return "INTERNAL_ERROR";
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asInt(v: unknown): number | null {
  const n = asFiniteNumber(v);
  if (n == null) return null;
  return Math.round(n);
}

function isSafeReason(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/UNKNOWN_CONDITION|NORMALIZED|MATCH[_ ]KEY|private_config|fallback/i.test(s)) {
    return false;
  }
  return true;
}

function sanitizeEstimate(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (DTO_ESTIMATE_KEYS.indexOf(key) === -1) {
      /* drop unknown / private keys */
    }
  }
  const low = asFiniteNumber(src.market_low);
  const mid = asFiniteNumber(src.market_mid);
  const high = asFiniteNumber(src.market_high);
  const score = asInt(src.value_score);
  const cov = asInt(src.coverage_percent);
  const matched = asInt(src.matched_count);
  const total = asInt(src.total_count);
  if (low == null || mid == null || high == null) return null;
  if (score == null || cov == null || matched == null || total == null) return null;
  const reasons: string[] = [];
  if (Array.isArray(src.reasons)) {
    for (const item of src.reasons) {
      if (typeof item === "string" && isSafeReason(item)) reasons.push(item.trim());
      if (reasons.length >= 8) break;
    }
  }
  let updated = "";
  if (typeof src.market_updated_at === "string") updated = src.market_updated_at;
  return {
    market_low: low,
    market_mid: mid,
    market_high: high,
    value_score: Math.max(0, Math.min(100, score)),
    coverage_percent: Math.max(0, Math.min(100, cov)),
    matched_count: Math.max(0, matched),
    total_count: Math.max(0, total),
    market_updated_at: updated,
    reasons,
  };
}

function readTextField(v: unknown, max: number): string | null {
  if (v == null) return "";
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length > max) return null;
  return t;
}

function validateComponents(raw: unknown): { ok: true; components: Record<string, string>[] } | { ok: false; code: string } {
  if (!Array.isArray(raw)) return { ok: false, code: "INVALID_REQUEST" };
  if (raw.length > MAX_COMPONENTS) return { ok: false, code: "TOO_MANY_COMPONENTS" };
  if (raw.length < 1) return { ok: false, code: "INVALID_REQUEST" };
  const out: Record<string, string>[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    const rec = row as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (
        key !== "category" &&
        key !== "brand" &&
        key !== "model" &&
        key !== "variant" &&
        key !== "component_type"
      ) {
        return { ok: false, code: "INVALID_REQUEST" };
      }
    }
    const categoryRaw = readTextField(rec.category, 40);
    const typeRaw = readTextField(rec.component_type, 40);
    const brand = readTextField(rec.brand, 100);
    const model = readTextField(rec.model, 160);
    const variant = readTextField(rec.variant, 160);
    if (categoryRaw == null || typeRaw == null || brand == null || model == null || variant == null) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    const category = (categoryRaw || typeRaw).toUpperCase();
    if (categoryRaw && typeRaw && categoryRaw.toUpperCase() !== typeRaw.toUpperCase()) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    if (!category || !brand || !model) return { ok: false, code: "INVALID_REQUEST" };
    if (ALLOWED_CATEGORIES.indexOf(category) === -1) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    out.push({
      category,
      brand,
      model,
      variant,
    });
  }
  return { ok: true, components: out };
}

function isValidIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
    if (String(n) !== p) return false;
  }
  return true;
}

function isValidIpv6(s: string): boolean {
  if (!s || s.indexOf(":") === -1) return false;
  if (/[^0-9a-fA-F:]/.test(s)) return false;
  if (s.split("::").length > 2) return false;
  const groups = s.split(":");
  if (groups.length < 3 || groups.length > 8) return false;
  for (const g of groups) {
    if (g === "") continue;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
  }
  return true;
}

function normalizeIpCandidate(raw: string): string {
  let s = String(raw || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 1) s = s.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(":"));
  }
  return s.trim();
}

function clientIpFromHeaders(req: Request): string | null {
  const cf = normalizeIpCandidate(req.headers.get("cf-connecting-ip") || "");
  if (cf && (isValidIpv4(cf) || isValidIpv6(cf))) return cf;
  const xff = String(req.headers.get("x-forwarded-for") || "");
  if (xff.trim()) {
    const first = normalizeIpCandidate(xff.split(",")[0] || "");
    if (first && (isValidIpv4(first) || isValidIpv6(first))) return first;
  }
  const real = normalizeIpCandidate(req.headers.get("x-real-ip") || "");
  if (real && (isValidIpv4(real) || isValidIpv6(real))) return real;
  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function mapRpcFailure(err: { message?: string } | null): string {
  const msg = String((err && err.message) || "");
  if (!msg) return "INTERNAL_ERROR";
  if (msg.indexOf("INVALID_REQUEST") !== -1) return "INVALID_REQUEST";
  if (msg.indexOf("TOO_MANY_COMPONENTS") !== -1) return "TOO_MANY_COMPONENTS";
  if (msg.indexOf("NO_ACTIVE_MARKET") !== -1) return "NO_ACTIVE_MARKET";
  if (msg.indexOf("NO_ACTIVE_RULE") !== -1) return "NO_ACTIVE_RULE";
  if (msg.indexOf("INSUFFICIENT_MARKET_DATA") !== -1) return "INSUFFICIENT_MARKET_DATA";
  if (msg.indexOf("RATE_LIMITED") !== -1) return "RATE_LIMITED";
  return "INTERNAL_ERROR";
}

Deno.serve(async (req: Request) => {
  const origin = String(req.headers.get("Origin") || "").trim();
  if (!isAllowedOrigin(origin)) {
    return rejectUnknownOrigin();
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json(publicError("INVALID_REQUEST"), 400, origin);
  }

  const contentType = String(req.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.indexOf("application/json") === -1) {
    return json(publicError("INVALID_REQUEST"), 400, origin);
  }

  const lengthHeader = req.headers.get("Content-Length");
  if (lengthHeader != null && String(lengthHeader).trim() !== "") {
    const declared = Number(lengthHeader);
    if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
      return json(publicError("INVALID_REQUEST"), 413, origin);
    }
  }

  let bodyBuf: ArrayBuffer;
  try {
    bodyBuf = await req.arrayBuffer();
  } catch {
    return json(publicError("INVALID_REQUEST"), 400, origin);
  }
  if (bodyBuf.byteLength > MAX_BODY_BYTES) {
    return json(publicError("INVALID_REQUEST"), 413, origin);
  }

  const supabaseUrl = firstEnv(["SUPABASE_URL"]);
  const serviceKey = firstEnv([
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SECRET_KEYS",
  ]);
  const salt = rateLimitSalt();
  if (!supabaseUrl || !serviceKey || !salt) {
    return json(publicError("INTERNAL_ERROR"), 500, origin);
  }

  const clientIp = clientIpFromHeaders(req);
  if (!clientIp) {
    return json(publicError("INTERNAL_ERROR"), 500, origin);
  }

  let clientHash = "";
  try {
    clientHash = await sha256Hex(salt + HASH_SEPARATOR + clientIp);
  } catch {
    return json(publicError("INTERNAL_ERROR"), 500, origin);
  }
  if (!/^[0-9a-f]{64}$/.test(clientHash)) {
    return json(publicError("INTERNAL_ERROR"), 500, origin);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const rl = await supabase.rpc("service_used_valuation_rate_limit", {
      p_client_hash: clientHash,
    });
    if (rl.error || !rl.data || typeof rl.data !== "object" || Array.isArray(rl.data)) {
      return json(publicError("INTERNAL_ERROR"), 500, origin);
    }
    const rlRow = rl.data as Record<string, unknown>;
    if (rlRow.ok === false) {
      return json(publicError("INTERNAL_ERROR"), 500, origin);
    }
    if (rlRow.allowed !== true) {
      const retry = asInt(rlRow.retry_after_seconds);
      const retryAfter = retry != null && retry > 0 ? retry : 1;
      return json(
        {
          ok: false,
          code: "RATE_LIMITED",
          message: "操作過於頻繁，請稍後再試。",
          retry_after_seconds: retryAfter,
        },
        429,
        origin,
        { "Retry-After": String(retryAfter) },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBuf));
    } catch {
      return json(publicError("INVALID_REQUEST"), 400, origin);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(publicError("INVALID_REQUEST"), 400, origin);
    }
    const payload = parsed as Record<string, unknown>;
    for (const key of Object.keys(payload)) {
      if (key !== "components") {
        return json(publicError("INVALID_REQUEST"), 400, origin);
      }
    }

    const checked = validateComponents(payload.components);
    if (!checked.ok) {
      const code = mapPublicCode(checked.code);
      return json(publicError(code), statusFor(code), origin);
    }

    const { data, error } = await supabase.rpc("service_used_valuation_public_estimate", {
      p_payload: { components: checked.components },
    });
    if (error) {
      const code = mapPublicCode(mapRpcFailure(error));
      return json(publicError(code), statusFor(code), origin);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return json(publicError("INTERNAL_ERROR"), 500, origin);
    }
    const row = data as Record<string, unknown>;
    if (row.ok === false) {
      const code = mapPublicCode(String(row.code || "INTERNAL_ERROR"));
      return json(publicError(code), statusFor(code), origin);
    }
    if (row.ok !== true) {
      return json(publicError("INTERNAL_ERROR"), 500, origin);
    }
    const estimate = sanitizeEstimate(row.estimate);
    if (!estimate) {
      return json(publicError("INTERNAL_ERROR"), 500, origin);
    }
    return json({ ok: true, estimate }, 200, origin);
  } catch {
    return json(publicError("INTERNAL_ERROR"), 500, origin);
  }
});
