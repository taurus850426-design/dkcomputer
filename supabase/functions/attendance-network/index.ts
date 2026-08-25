/**
 * Stage 11-5 COMPANY_NETWORK gateway.
 * - Public IP is taken from request headers only (never from JSON body).
 * - *_company_network RPCs are invoked with service_role after JWT user is verified.
 * - Client-supplied ip / verified / employee_id are ignored.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type PunchKind = "clock_in" | "clock_out" | "break_start" | "break_end";

const PUNCH_RPC: Record<PunchKind, string> = {
  clock_in: "attendance_clock_in_company_network",
  clock_out: "attendance_clock_out_company_network",
  break_start: "attendance_break_start_company_network",
  break_end: "attendance_break_end_company_network",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function isValidIp(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) {
    return s.split(".").every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  // IPv6 (basic)
  if (s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s)) return true;
  return false;
}

function isLoopbackOrUnspecified(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "127.0.0.1" || s.startsWith("127.")) return true;
  if (s === "::1" || s === "0.0.0.0" || s === "::") return true;
  return false;
}

/** Prefer platform headers; never trust body. Walk XFF from right for first public-looking hop. */
function extractClientPublicIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && isValidIp(cf) && !isLoopbackOrUnspecified(cf.trim())) {
    return cf.trim();
  }
  const real = req.headers.get("x-real-ip");
  if (real && isValidIp(real) && !isLoopbackOrUnspecified(real.trim())) {
    return real.trim();
  }
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter((p) => isValidIp(p) && !isLoopbackOrUnspecified(p));
    if (parts.length === 1) return parts[0];
    if (parts.length > 1) {
      // Rightmost is typically closest to our edge; leftmost may be client-spoofed.
      return parts[parts.length - 1];
    }
  }
  return null;
}

function normalizeIpList(raw: unknown): string[] {
  const out: string[] = [];
  const pushOne = (item: unknown) => {
    let s = String(item ?? "").trim();
    if (!s) return;
    // Postgres array text: {a,b} or {"a","b"}
    if (s.startsWith("{") && s.endsWith("}") && !s.includes(":")) {
      const inner = s.slice(1, -1);
      inner.split(",").forEach((part) => pushOne(part.replace(/^"|"$/g, "").trim()));
      return;
    }
    s = s.replace(/^"|"$/g, "").trim();
    // inet may serialize as "x.x.x.x" or "x.x.x.x/32"
    const host = s.includes("/") ? s.split("/")[0] : s;
    if (isValidIp(host)) out.push(host);
  };

  if (raw == null) return out;
  if (Array.isArray(raw)) {
    raw.forEach(pushOne);
    return out;
  }
  if (typeof raw === "string") {
    pushOne(raw);
    return out;
  }
  // Rare: { "0": "1.2.3.4" } style
  if (typeof raw === "object") {
    Object.values(raw as Record<string, unknown>).forEach(pushOne);
  }
  return out;
}

function ipAllowed(clientIp: string, allow: string[]): boolean {
  const c = clientIp.toLowerCase();
  return allow.some((a) => a.toLowerCase() === c);
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
            if (item && typeof item === "object" && typeof (item as { key?: string }).key === "string") {
              const k = String((item as { key: string }).key).trim();
              if (k) return k;
            }
          }
        }
      } catch {
        /* fall through */
      }
    }
    if (t.startsWith("{") && t.includes(":")) {
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === "object") {
          for (const val of Object.values(obj)) {
            if (typeof val === "string" && val.trim()) return val.trim();
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  const supabaseUrl = firstEnv(["SUPABASE_URL"]);
  const anonKey = firstEnv([
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_KEYS",
  ]);
  const serviceKey = firstEnv([
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SECRET_KEYS",
  ]);

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({
      ok: false,
      error: "edge misconfigured",
      code: "edge_misconfigured",
      has_url: !!supabaseUrl,
      has_anon: !!anonKey,
      has_service: !!serviceKey,
    }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ ok: false, error: "not authenticated" }, 401);
  }

  // Ignore any client-supplied IP / employee_id / verified flags in body.
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = String(body.action || "");

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user?.id) {
    return json({ ok: false, error: "not authenticated" }, 401);
  }

  const seenIp = extractClientPublicIp(req);

  if (action === "detect_ip") {
    return json({
      ok: true,
      server_seen_ip: seenIp,
      note: "IP from Edge request headers only; body IP ignored",
    });
  }

  if (action === "save_current_network") {
    if (!seenIp) {
      return json({ ok: false, error: "unable to determine client ip" }, 400);
    }
    const { data: prof, error: profErr } = await userClient
      .from("profiles")
      .select("id,role,enabled")
      .eq("id", user.id)
      .maybeSingle();
    if (
      profErr ||
      !prof ||
      prof.enabled !== true ||
      String(prof.role) !== "admin"
    ) {
      return json({ ok: false, error: "admin only" }, 403);
    }

    const { data: settings, error: setErr } = await adminClient
      .from("attendance_settings")
      .select("network_enabled,allowed_public_ips")
      .eq("id", 1)
      .maybeSingle();
    if (setErr || !settings) {
      return json({ ok: false, error: "settings missing" }, 500);
    }
    const existing = normalizeIpList(settings.allowed_public_ips);
    const merged = Array.from(new Set([...existing, seenIp]));
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : "capture current company network from Edge";

    // Use caller JWT so attendance_admin_save_network can is_admin()+auth.uid().
    // IP list is Edge-authored only for this action (not from client body).
    const { data: saved, error: saveErr } = await userClient.rpc(
      "attendance_admin_save_network",
      {
        p_enabled: true,
        p_allowed_public_ips: merged,
        p_reason: reason,
      },
    );
    if (saveErr) {
      return json(
        { ok: false, error: saveErr.message || "save network failed" },
        400,
      );
    }
    return json({
      ok: true,
      server_seen_ip: seenIp,
      network_enabled: true,
      allowed_public_ips: merged,
      rpc: saved,
    });
  }

  if (action === "punch") {
    const punch = String(body.punch || "") as PunchKind;
    if (!PUNCH_RPC[punch]) {
      return json({ ok: false, error: "invalid punch" }, 400);
    }
    if (!seenIp) {
      return json({
        ok: false,
        network_ok: false,
        code: "ip_unavailable",
        error: "unable to determine client ip",
        server_seen_ip: null,
      });
    }

    const { data: settings, error: setErr } = await adminClient
      .from("attendance_settings")
      .select("network_enabled,allowed_public_ips")
      .eq("id", 1)
      .maybeSingle();
    if (setErr || !settings) {
      return json({
        ok: false,
        network_ok: false,
        code: "settings_missing",
        error: setErr && setErr.message ? setErr.message : "settings missing",
        server_seen_ip: seenIp,
      });
    }
    if (settings.network_enabled !== true && settings.network_enabled !== "true") {
      return json({
        ok: false,
        network_ok: false,
        code: "network_disabled",
        error: "company network not enabled",
        server_seen_ip: seenIp,
        network_enabled: settings.network_enabled,
      });
    }
    const allow = normalizeIpList(settings.allowed_public_ips);
    if (!allow.length || !ipAllowed(seenIp, allow)) {
      return json({
        ok: false,
        network_ok: false,
        code: "network_mismatch",
        error: "not on company network",
        server_seen_ip: seenIp,
        allow_count: allow.length,
        // Safe diagnostics only (IPs already known to admin settings).
        allowed_public_ips: allow,
        raw_allowed_type: settings.allowed_public_ips == null
          ? "null"
          : Array.isArray(settings.allowed_public_ips)
          ? "array"
          : typeof settings.allowed_public_ips,
      });
    }

    const rpcName = PUNCH_RPC[punch];
    const { data, error } = await adminClient.rpc(rpcName, {
      p_employee_id: user.id,
    });
    if (error) {
      return json({
        ok: false,
        network_ok: true,
        code: "rpc_failed",
        error: error.message || "company network punch failed",
        server_seen_ip: seenIp,
        rpc: rpcName,
      }, 400);
    }
    return json({
      ok: true,
      network_ok: true,
      verification_mode: "COMPANY_NETWORK",
      server_seen_ip: seenIp,
      data,
    });
  }

  return json({ ok: false, error: "unknown action", code: "unknown_action" }, 400);
});
