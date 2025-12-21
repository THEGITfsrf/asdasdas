self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", evt => evt.waitUntil(self.clients.claim()));

self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  if (url.pathname.endsWith("/sw.js")) return;

  evt.respondWith(handleFetch(evt.request));
});

async function handleFetch(request) {
  const client = await self.clients.get(request.clientId);

  if (!client) return fetch(request);

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
    const timeout = setTimeout(() => reject("timeout"), 15000);

    function onMessage(evt) {
      if (evt.data?.id !== id) return;

      clearTimeout(timeout);
      self.removeEventListener("message", onMessage);

      const res = evt.data.res;
      resolve(
        new Response(
          res.body ? new Uint8Array(res.body) : null,
          { status: res.status, headers: res.headers }
        )
      );
    }

    self.addEventListener("message", onMessage);
  });
}
