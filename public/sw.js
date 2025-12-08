self.addEventListener("install", evt => self.skipWaiting());
self.addEventListener("activate", evt => evt.waitUntil(self.clients.claim()));

self.addEventListener("fetch", evt => {
  const req = evt.request;
  const url = new URL(req.url);

  // Don’t intercept the main page or static assets
  if (url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
    return; // let the network handle it
  }

  // Only proxy other requests
  evt.respondWith((async () => {
    const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    if (!allClients.length) {
      return fetch(req); // fallback to network if no client
    }

    const client = allClients[0];
    const mc = new MessageChannel();
    const resp = new Promise(resolve => { mc.port1.onmessage = ev => resolve(ev.data); });

    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    client.postMessage({ type: "fetch-proxy", req: { url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body } }, [mc.port2]);

    const data = await resp;
    return new Response(data.body, { status: 200, headers: { "Content-Type": "application/json" } });
  })());
});
