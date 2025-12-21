self.addEventListener("install", () => {
  console.log("[SW] install");
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  console.log("[SW] activate");
  e.waitUntil(self.clients.claim());
});

// pending fetch resolvers
const pending = new Map();

// 🔒 MUST be top-level
self.addEventListener("message", evt => {
  console.log("[SW] message event received", evt.data);

  const { id, res } = evt.data || {};
  if (!id) {
    console.warn("[SW] message missing id");
    return;
  }

  if (!pending.has(id)) {
    console.warn("[SW] no pending entry for id", id);
    return;
  }

  const { resolve, timeout } = pending.get(id);
  clearTimeout(timeout);
  pending.delete(id);

  console.log("[SW] resolving fetch", {
    id,
    status: res?.status,
    hasBody: !!res?.body
  });

  resolve(
    new Response(
      res?.body ? new Uint8Array(res.body) : null,
      {
        status: res?.status || 200,
        headers: res?.headers || {}
      }
    )
  );
});

self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  if (url.pathname.endsWith("/sw.js")) return;

  console.log("[SW] intercept fetch", {
    url: evt.request.url,
    method: evt.request.method
  });

  evt.respondWith(handleFetch(evt.request));
});

async function handleFetch(request) {
  console.log("[SW] handleFetch start", request.url);

  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  console.log("[SW] clients found", clients.length);

  const client = clients[0];
  if (!client) {
    console.error("[SW] no client available");
    return new Response("No client available", { status: 502 });
  }

  const id = crypto.randomUUID();
  console.log("[SW] generated id", id);

  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
    console.log("[SW] request has body", body.byteLength);
  }

  console.log("[SW] posting proxy-fetch to page", {
    id,
    url: request.url
  });

  client.postMessage({
    type: "proxy-fetch",
    id,
    req: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: body ? Array.from(new Uint8Array(body)) : null
    }
  });

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      console.error("[SW] proxy timeout", id);
      pending.delete(id);
      resolve(new Response("Proxy timeout", { status: 502 }));
    }, 15000);

    pending.set(id, { resolve, timeout });
    console.log("[SW] pending set", id);
  });
}
