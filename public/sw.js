self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", evt =>
  evt.waitUntil(self.clients.claim())
);

self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // never intercept the SW itself
  if (url.pathname.endsWith("/sw.js")||url.pathname==("/")) return;

  evt.respondWith(handleFetch(evt.request));
});

async function handleFetch(request) {
  // grab ANY controlled window
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  const client = clients[0];
  if (!client) {
    // stealth rule: never leak to network
    return new Response("No client bound", { status: 502 });
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

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("proxy timeout"));
    }, 15000);

    function onMessage(evt) {
      if (evt.data?.id !== id) return;

      clearTimeout(timeout);
      self.removeEventListener("message", onMessage);

      const res = evt.data.res;

      resolve(
        new Response(
          res.body ? new Uint8Array(res.body) : null,
          {
            status: res.status || 200,
            headers: res.headers || {}
          }
        )
      );
    }

    self.addEventListener("message", onMessage);
  });
}
