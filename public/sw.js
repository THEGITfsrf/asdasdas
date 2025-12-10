let sharedPort = null;

self.addEventListener("install", evt => {
  console.log("[SW] Installing...");
  self.skipWaiting();
});

self.addEventListener("activate", evt => {
  console.log("[SW] Activating...");
  evt.waitUntil(self.clients.claim());
});

/* Receive the SharedWorker port from the page */
self.addEventListener("message", evt => {
  if (evt.data?.type === "connect-shared-worker") {
    sharedPort = evt.ports[0];
    console.log("[SW] Connected SharedWorker port");
  }
});

self.addEventListener("fetch", evt => {
  // Don't proxy the SW or SharedWorker
  if (evt.request.url.endsWith("sw.js") ||
      evt.request.url.endsWith("shared.js")) {
    return;
  }

  evt.respondWith(proxyThroughWS(evt.request));
});

async function proxyThroughWS(request) {
  if (!sharedPort) {
    console.warn("[SW] No SharedWorker port, falling back to network");
    return fetch(request);
  }

  const id = crypto.randomUUID();

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();

  const wrapper = {
    id,
    req: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body
    }
  };

  const responsePromise = new Promise(resolve => {
    function handler(evt) {
      if (evt.data?.id === id) {
        sharedPort.removeEventListener("message", handler);
        resolve(evt.data);
      }
    }
    sharedPort.addEventListener("message", handler);
  });

  sharedPort.postMessage(wrapper);

  const result = await responsePromise;

  return new Response(result.body, {
    status: result.status,
    headers: result.headers
  });
}
