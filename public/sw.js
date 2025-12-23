// sw.js
self.addEventListener("install", () => {
  console.log("[SW] install");
  self.skipWaiting();
});

self.addEventListener("activate", evt => {
  console.log("[SW] activate");
  evt.waitUntil(self.clients.claim());
});

const pending = new Map();

// Message listener (top-level, fixes warning)
self.addEventListener("message", evt => {
  const { id, res } = evt.data || {};
  if (!id || !pending.has(id)) return;

  const { resolve, timeout } = pending.get(id);
  clearTimeout(timeout);
  pending.delete(id);

  let bodyStr = null;

  if (res.body) {
    if (Array.isArray(res.body)) {
      // Convert number array back into string
      bodyStr = String.fromCharCode(...res.body);
    } else if (typeof res.body === "string") {
      // Already a string
      bodyStr = res.body;
    }
  }

  resolve(
    new Response(bodyStr, {
      status: res.status || 200,
      headers: res.headers || {}
    })
  );
});



self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // Never intercept SW itself
  if (url.pathname.endsWith("/sw.js")) return;

  // Only proxy /api/
  if (!url.pathname.startsWith("/apx/")) {
    return; // fallback to network
  }

  console.log("[SW] intercept fetch", { url: url.href, method: evt.request.method });
  evt.respondWith(handleFetch(evt.request));
});

async function handleFetch(request) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients[0];
  if (!client) return fetch(request); // fallback if no client

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
      console.warn("[SW] proxy timeout", id);
    }, 15000);

    pending.set(id, { resolve, timeout });
  });
}
