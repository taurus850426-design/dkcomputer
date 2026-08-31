/**
 * Stage 15-4C：Admin 更新後台 profile（display_name / role / enabled）。
 * 不改 username、不改 Auth email、不刪 Auth User。
 * 最後一位 enabled admin 與目前登入者鎖死：server-side 拒絕。
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DISPLAY_NAME_MAX = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
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
    return json({ ok: false, code: "method_not_allowed", error: "method not allowed" }, 405);
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
      code: "edge_misconfigured",
      error: "edge misconfigured",
      has_url: !!supabaseUrl,
      has_anon: !!anonKey,
      has_service: !!serviceKey,
    }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ ok: false, code: "unauthenticated", error: "not authenticated" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, code: "validation", error: "invalid json" }, 400);
  }

  const targetId = String(body.user_id ?? "").trim();
  const displayName = String(body.display_name ?? "").trim();
  const role = String(body.role ?? "").trim();
  const enabled = body.enabled === true ? true : body.enabled === false ? false : null;

  if (!UUID_RE.test(targetId)) {
    return json({ ok: false, code: "validation", error: "invalid user_id" }, 400);
  }
  if (!displayName || displayName.length > DISPLAY_NAME_MAX) {
    return json({ ok: false, code: "validation", error: "invalid display_name" }, 400);
  }
  if (role !== "admin" && role !== "staff") {
    return json({ ok: false, code: "validation", error: "invalid role" }, 400);
  }
  if (enabled == null) {
    return json({ ok: false, code: "validation", error: "invalid enabled" }, 400);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const caller = userData?.user;
  if (userErr || !caller?.id) {
    return json({ ok: false, code: "unauthenticated", error: "not authenticated" }, 401);
  }

  const { data: callerProf, error: callerErr } = await userClient
    .from("profiles")
    .select("id,role,enabled")
    .eq("id", caller.id)
    .maybeSingle();
  if (
    callerErr ||
    !callerProf ||
    callerProf.enabled !== true ||
    String(callerProf.role) !== "admin"
  ) {
    return json({ ok: false, code: "forbidden", error: "admin only" }, 403);
  }

  const { data: target, error: targetErr } = await adminClient
    .from("profiles")
    .select("id,username,display_name,role,enabled")
    .eq("id", targetId)
    .maybeSingle();
  if (targetErr) {
    return json({ ok: false, code: "network", error: "profile lookup failed" }, 500);
  }
  if (!target) {
    return json({ ok: false, code: "not_found", error: "profile not found" }, 404);
  }

  const isSelf = String(target.id) === String(caller.id);
  if (isSelf && (enabled === false || role === "staff")) {
    return json({
      ok: false,
      code: "self_lock",
      error: "cannot disable or demote the signed-in admin",
    }, 403);
  }

  const { data: adminRows, error: adminErr } = await adminClient
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .eq("enabled", true);
  if (adminErr) {
    return json({ ok: false, code: "network", error: "admin count failed" }, 500);
  }
  const enabledAdminIds = (adminRows || []).map((r) => String(r.id));
  const others = enabledAdminIds.filter((id) => id !== String(target.id));
  const targetIsLiveAdmin = String(target.role) === "admin" && target.enabled === true;
  const wouldDropAdmin = targetIsLiveAdmin && (enabled === false || role === "staff");
  if (wouldDropAdmin && others.length < 1) {
    return json({
      ok: false,
      code: "last_admin",
      error: "cannot disable or demote the last enabled admin",
    }, 403);
  }

  const updated = await adminClient
    .from("profiles")
    .update({
      display_name: displayName,
      role,
      enabled,
    })
    .eq("id", targetId)
    .select("id,username,display_name,role,enabled")
    .maybeSingle();
  if (updated.error || !updated.data) {
    return json({ ok: false, code: "update_failed", error: "profile update failed" }, 500);
  }

  const row = updated.data;
  return json({
    ok: true,
    user: {
      id: String(row.id),
      username: String(row.username || ""),
      display_name: String(row.display_name || displayName),
      role: row.role === "admin" ? "admin" : "staff",
      enabled: row.enabled === true,
    },
  });
});
