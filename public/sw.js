self.addEventListener("install", evt => self.skipWaiting());
self.addEventListener("activate", evt => evt.waitUntil(self.clients.claim()));

self.addEventListener("fetch", evt => {
  const req = evt.request;

  evt.respondWith((async () => {
    // Wait for a page client to appear (retry a few times)
    let allClients;
    for (let i = 0; i < 10; i++) { // 10 tries
      allClients = await self.clients.matchAll({ includeUncontrolled:true, type:"window" });
      if (allClients.length) break;
      await new Promise(r => setTimeout(r, 100)); // wait 100ms
    }

    if (!allClients || !allClients.length) {
      return new Response(JSON.stringify({ error: "No page client available" }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
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
