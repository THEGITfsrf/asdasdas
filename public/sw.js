self.addEventListener("install", evt => self.skipWaiting());
self.addEventListener("activate", evt => evt.waitUntil(self.clients.claim()));

self.addEventListener("fetch", evt => {
  const req = evt.request;

  // Send all requests to backend via page (no exceptions)
  evt.respondWith((async () => {
    const allClients = await self.clients.matchAll({ includeUncontrolled:true, type:"window" });
    if (!allClients.length) return new Response("No page client", { status:502 });
    const client = allClients[0];

    // MessageChannel to communicate with page
    const mc = new MessageChannel();
    const resp = new Promise(resolve => { mc.port1.onmessage = ev => resolve(ev.data); });

    const body = req.method==="GET"||req.method==="HEAD"?null:await req.text();
    client.postMessage({ type:"fetch-proxy", req:{ url:req.url, method:req.method, headers:Object.fromEntries(req.headers), body } }, [mc.port2]);

    const data = await resp;
    return new Response(data.body, { status:200, headers:{ "Content-Type":"application/json" } });
  })());
});
