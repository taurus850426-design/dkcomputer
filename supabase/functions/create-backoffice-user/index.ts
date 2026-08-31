/**
 * Stage 15-4B：Admin 建立後台登入帳號（Auth User + public.profiles）。
 * - 必須帶呼叫者 JWT；Admin 判定只看 server-side profiles。
 * - service_role 只在此 Edge Function 使用，不得進前端。
 * - 回應不得含 password / service_role / access_token。
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AUTH_EMAIL_DOMAIN = "login.dkcomputer.internal";
const USERNAME_MAX = 64;
const DISPLAY_NAME_MAX = 80;
const PASSWORD_MIN = 6;

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

/** 與 shared.js adminUsernameToAuthEmail 同一規則。 */
function usernameToAuthEmail(username: string): string | null {
  const u = String(username == null ? "" : username).trim().toLowerCase();
  if (!u) return null;
  if (u.length > USERNAME_MAX) return null;
  if (u.indexOf("@") !== -1) return null;
  if (/\s/.test(u)) return null;
  if (/[^a-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(u)) return null;
  if (u.charAt(0) === "." || u.charAt(u.length - 1) === "." || u.indexOf("..") !== -1) {
    return null;
  }
  return u + "@" + AUTH_EMAIL_DOMAIN;
}

function isDuplicateAuthError(err: { message?: string; code?: string; status?: number } | null): boolean {
  if (!err) return false;
  const msg = String(err.message || "").toLowerCase();
  const code = String(err.code || "").toLowerCase();
  const status = Number(err.status || 0);
  if (status === 409 || status === 422) return true;
  if (code === "email_exists" || code === "user_already_exists") return true;
  if (msg.indexOf("already been registered") !== -1) return true;
  if (msg.indexOf("already exists") !== -1) return true;
  if (msg.indexOf("duplicate") !== -1) return true;
  return false;
}

function isUniqueViolation(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || "").toLowerCase();
  return code === "23505" || msg.indexOf("duplicate") !== -1 || msg.indexOf("unique") !== -1;
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

  const displayName = String(body.display_name ?? "").trim();
  const usernameRaw = String(body.username ?? "").trim();
  const username = usernameRaw.toLowerCase();
  const role = String(body.role ?? "").trim();
  const password = typeof body.password === "string" ? body.password : "";

  if (!displayName || displayName.length > DISPLAY_NAME_MAX) {
    return json({ ok: false, code: "validation", error: "invalid display_name" }, 400);
  }
  const email = usernameToAuthEmail(usernameRaw);
  if (!email || !username) {
    return json({ ok: false, code: "validation", error: "invalid username" }, 400);
  }
  if (role !== "admin" && role !== "staff") {
    return json({ ok: false, code: "validation", error: "invalid role" }, 400);
  }
  if (!password || password.length < PASSWORD_MIN) {
    return json({ ok: false, code: "validation", error: "invalid password" }, 400);
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

  const { data: prof, error: profErr } = await userClient
    .from("profiles")
    .select("id,role,enabled")
    .eq("id", caller.id)
    .maybeSingle();
  if (
    profErr ||
    !prof ||
    prof.enabled !== true ||
    String(prof.role) !== "admin"
  ) {
    return json({ ok: false, code: "forbidden", error: "admin only" }, 403);
  }

  const { data: existingRows, error: existErr } = await adminClient
    .from("profiles")
    .select("id,username")
    .ilike("username", username);
  if (existErr) {
    return json({ ok: false, code: "network", error: "profile lookup failed" }, 500);
  }
  if (existingRows && existingRows.length > 0) {
    return json({ ok: false, code: "conflict", error: "username already exists" }, 409);
  }

  const created = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      display_name: displayName,
      role,
    },
  });
  if (created.error || !created.data?.user?.id) {
    if (isDuplicateAuthError(created.error)) {
      return json({ ok: false, code: "conflict", error: "username already exists" }, 409);
    }
    return json({ ok: false, code: "auth_create_failed", error: "auth user create failed" }, 500);
  }

  const userId = String(created.data.user.id);
  const inserted = await adminClient.from("profiles").insert({
    id: userId,
    username,
    display_name: displayName,
    role,
    enabled: true,
  }).select("id,username,display_name,role,enabled").maybeSingle();

  if (inserted.error || !inserted.data) {
    const del = await adminClient.auth.admin.deleteUser(userId);
    if (del.error) {
      return json({
        ok: false,
        code: "rollback_failed",
        error: "profile insert failed; auth user rollback failed",
        user_id: userId,
      }, 500);
    }
    if (isUniqueViolation(inserted.error)) {
      return json({ ok: false, code: "conflict", error: "username already exists" }, 409);
    }
    return json({
      ok: false,
      code: "profile_failed",
      error: "profile insert failed",
      user_id: userId,
    }, 500);
  }

  const row = inserted.data;
  return json({
    ok: true,
    user: {
      id: String(row.id),
      username: String(row.username || username),
      display_name: String(row.display_name || displayName),
      role: row.role === "admin" ? "admin" : "staff",
      enabled: row.enabled === true,
    },
  });
});
