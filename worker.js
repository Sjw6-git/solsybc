// worker.js — SolSync Lite (R2 one-time download + mobile-safe redirect)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // ---------- CORS preflight ----------
    if (method === "OPTIONS") return preflight(req, env);

    // ---------- config ----------
    // Where to land users when they hit the Worker root:
    const TARGET =
      env.PUBLIC_APP_URL ||
      "https://pub-3063a45b808246b985290548b748f25c.r2.dev/photosync/upload.html?v=14";

    // ---------- health ----------
    if (method === "GET" && url.pathname === "/health") {
      return withCORS(new Response("ok", { status: 200 }), env);
    }

    // ---------- mobile-proof root redirect ----------
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = `<!doctype html>
<meta charset="utf-8">
<title>Redirecting…</title>
<meta http-equiv="refresh" content="0; url=${TARGET}">
<p>If you are not redirected, <a href="${TARGET}">tap here</a>.</p>
<script>location.replace(${JSON.stringify(TARGET)});</script>`;
      return withCORS(new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }), env);
    }

    // ---------- API: create upload + one-time download pair ----------
    if (method === "POST" && url.pathname === "/api/create") {
      return createUpload(env, url);
    }

    // ---------- API: direct PUT upload from browser ----------
    if (method === "PUT" && url.pathname.startsWith("/upload/")) {
      const id = url.pathname.split("/").pop();
      return putFile(env, req, id, ctx);
    }

    // ---------- API: one-time download (stream + delete) ----------
    if (method === "GET" && url.pathname.startsWith("/d/")) {
      const id = url.pathname.split("/").pop();
      return oneTimeDownload(env, id, ctx);
    }

    // ---------- fallback for any other GET: show HTML redirect ----------
    if (method === "GET") {
      const html = `<!doctype html>
<meta charset="utf-8">
<title>Redirecting…</title>
<meta http-equiv="refresh" content="0; url=${TARGET}">
<p><a href="${TARGET}">Continue to uploader</a></p>
<script>location.replace(${JSON.stringify(TARGET)});</script>`;
      return withCORS(new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }), env);
    }

    return new Response("Not found", { status: 404 });
  }
};

// ================= helpers =================

function uid() { return crypto.randomUUID().replace(/-/g, ""); }

function preflight(req, env) {
  const allowOrigin = env.ALLOWED_ORIGIN || "*";
  const reqHeaders = req.headers.get("access-control-request-headers") || "content-type, x-filename";
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
      "access-control-allow-headers": reqHeaders,
      "access-control-max-age": "86400",
      "cache-control": "no-store",
      "vary": "origin, access-control-request-headers"
    }
  });
}

function withCORS(res, env) {
  const allowOrigin = env.ALLOWED_ORIGIN || "*";
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", allowOrigin);
  h.set("access-control-allow-methods", "GET,PUT,POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type, x-filename");
  h.set("cache-control", "no-store");
  h.set("vary", "origin, access-control-request-headers");
  return new Response(res.body, { status: res.status, headers: h });
}

async function createUpload(env, url) {
  const id  = uid();
  const ttl = Number(env.TTL_SECONDS || 1800); // seconds

  // stub lets us carry createdAt, and a sweeper could remove stale ones
  await env.BUCKET.put(id + ".stub", "1", {
    customMetadata: { createdAt: String(Date.now()) }
  });

  const uploadUrl   = new URL(url); uploadUrl.pathname   = `/upload/${id}`;
  const downloadUrl = new URL(url); downloadUrl.pathname = `/d/${id}`;

  const body = JSON.stringify({
    uploadUrl: uploadUrl.toString(),
    downloadUrl: downloadUrl.toString(),
    expiresAt: Date.now() + ttl * 1000
  });

  return withCORS(new Response(body, { headers: { "content-type": "application/json" } }), env);
}

async function putFile(env, req, id, ctx) {
  // Limits
  const max = Number(env.MAX_BYTES || 100 * 1024 * 1024); // default 100MB
  const len = Number(req.headers.get("content-length") || "0");
  if (len > max) return withCORS(new Response("File too large", { status: 413 }), env);

  const type = req.headers.get("content-type") || "application/octet-stream";
  const name = decodeURIComponent(req.headers.get("x-filename") || "");

  // carry createdAt from stub (for TTL)
  let createdAt = String(Date.now());
  try {
    const stub = await env.BUCKET.get(id + ".stub");
    if (stub?.customMetadata?.createdAt) createdAt = stub.customMetadata.createdAt;
  } catch {}

  await env.BUCKET.put(id, req.body, {
    httpMetadata: { contentType: type },
    customMetadata: { createdAt, name }
  });

  // remove stub in background
  try { ctx?.waitUntil(env.BUCKET.delete(id + ".stub")); } catch {}

  return withCORS(new Response("OK", { status: 200 }), env);
}

async function oneTimeDownload(env, id, ctx) {
  const ttl = Number(env.TTL_SECONDS || 1800);

  const obj = await env.BUCKET.get(id);
  if (!obj) return new Response("Link expired or file not found.", { status: 404 });

  // TTL enforcement
  const createdAt = Number(obj.customMetadata?.createdAt || 0);
  if (createdAt && Date.now() > createdAt + ttl * 1000) {
    try { ctx?.waitUntil(env.BUCKET.delete(id)); } catch {}
    return new Response("Link expired.", { status: 410 });
  }

  const name = obj.customMetadata?.name || "";
  const type = obj.httpMetadata?.contentType || "application/octet-stream";
  const disp = name
    ? `attachment; filename="${safeASCII(name)}"; filename*=UTF-8''${encodeRFC5987(name)}`
    : "attachment";

  // delete after stream starts (don’t block the response)
  try { ctx?.waitUntil(env.BUCKET.delete(id)); } catch {}

  return withCORS(new Response(obj.body, {
    headers: {
      "content-type": type,
      "content-disposition": disp
    }
  }), env);
}

function safeASCII(s){ return s.replace(/[^\x20-\x7E]+/g, "_"); }
function encodeRFC5987(str){
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}
