self.addEventListener("install", evt => self.skipWaiting());
self.addEventListener("activate", evt => evt.waitUntil(self.clients.claim()));

self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // Only intercept API requests under /api/
  if (!url.pathname.startsWith("/api/")) return;

  evt.respondWith((async () => {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    if (!clients.length) return fetch(evt.request); // fallback

    const client = clients[0];
    const mc = new MessageChannel();
    const resp = new Promise(resolve => mc.port1.onmessage = ev => resolve(ev.data));

    const body = evt.request.method === "GET" || evt.request.method === "HEAD" ? null : await evt.request.text();
    client.postMessage({
      type: "fetch-proxy",
      req: { url: evt.request.url, method: evt.request.method, headers: Object.fromEntries(evt.request.headers), body }
    }, [mc.port2]);

    const data = await resp;
    return new Response(data.body, { status: 200, headers: { "Content-Type": "application/json" } });
  })());
});
