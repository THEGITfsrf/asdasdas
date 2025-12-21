self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// pending fetch resolvers
const pending = new Map();

// 🔒 MUST be top-level (this fixes your warning)
self.addEventListener("message", evt => {
  const { id, res } = evt.data || {};
  if (!id || !pending.has(id)) return;

  const { resolve, timeout } = pending.get(id);
  clearTimeout(timeout);
  pending.delete(id);

  resolve(
    new Response(
      res.body ? new Uint8Array(res.body) : null,
      {
        status: res.status || 200,
        headers: res.headers || {}
      }
    )
  );
});

self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // never intercept the SW itself
  if (url.pathname.endsWith("/sw.js")) return;

  evt.respondWith(handleFetch(evt.request));
});

async function handleFetch(request) {
  // grab ANY available window
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  const client = clients[0];
  if (!client) {
    // stealth rule: never leak
    return new Response("No client available", { status: 502 });
  }

  const id = crypto.randomUUID();

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.arrayBuffer();

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
      pending.delete(id);
      resolve(new Response("Proxy timeout", { status: 502 }));
    }, 15000);

    pending.set(id, { resolve, timeout });
  });
}
