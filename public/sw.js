self.addEventListener("install", evt => {
  console.log("[SW] Installing...");
  self.skipWaiting();
});

self.addEventListener("activate", evt => {
  console.log("[SW] Activating...");
  evt.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);
  console.log("[SW] Fetch event for:", url.pathname);

  // Only intercept API requests under /api/
  if (!url.pathname.startsWith("/api/")) {
    console.log("[SW] Non-API request, letting network handle it:", url.pathname);
    return; // let network handle non-API requests
  }

  evt.respondWith((async () => {
    console.log("[SW] Intercepting API request:", url.pathname);

    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    if (!clients.length) {
      console.log("[SW] No clients available, falling back to network fetch");
      return fetch(evt.request); // fallback if no client
    }

    const client = clients[0];
    const mc = new MessageChannel();
    const resp = new Promise(resolve => {
      mc.port1.onmessage = ev => {
        console.log("[SW] Received response from client for", url.pathname, ":", ev.data);
        resolve(ev.data);
      };
    });

    const body = evt.request.method === "GET" || evt.request.method === "HEAD" ? null : await evt.request.text();
    console.log("[SW] Sending request to client:", { method: evt.request.method, body });

    client.postMessage({
      type: "fetch-proxy",
      req: { url: evt.request.url, method: evt.request.method, headers: Object.fromEntries(evt.request.headers), body }
    }, [mc.port2]);

    const data = await resp;
    console.log("[SW] Responding to fetch with client-provided data for", url.pathname);
    return new Response(data.body, { status: 200, headers: { "Content-Type": "application/json" } });
  })());
});
