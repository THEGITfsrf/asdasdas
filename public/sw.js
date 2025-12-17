const portsByClient = new Map(); // clientId -> MessagePort

self.addEventListener("install", evt => {
  console.log("[SW] Installing...");
  self.skipWaiting();
});

self.addEventListener("activate", evt => {
  console.log("[SW] Activating...");
  evt.waitUntil(self.clients.claim());
});

/* Receive the SharedWorker port from a page */
self.addEventListener("message", evt => {
  if (evt.data?.type === "connect-shared-worker") {
    const clientId = evt.source.id;
    const port = evt.ports[0];

    portsByClient.set(clientId, port);

    console.log(`[SW] Registered SharedWorker port for client ${clientId}`);
  }
});

/* Cleanup when a client disappears */
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // Never proxy SW / worker assets
  if (
    url.pathname === "/" ||
    url.pathname.endsWith("sw.js") ||
    url.pathname.endsWith("shared.js") ||
    url.pathname.endsWith("public.pem")
  ) {
    return;
  }

  // 🚨 IMPORTANT: handle navigations
  if (evt.request.mode === "navigate") {
    evt.respondWith(handleNavigation(evt));
    return;
  }

  // Normal resource fetch
  evt.respondWith(handleFetch(evt));
});

async function handleNavigation(evt) {
  const clientId = evt.clientId;
  const port = portsByClient.get(clientId);

  // If no port yet, allow initial load
  if (!port) {
    return fetch(evt.request);
  }

  // Proxy HTML navigation through backend
  return proxyThroughWS(evt.request, port, clientId);
}

async function handleFetch(evt) {
  const clientId = evt.clientId;
  const port = portsByClient.get(clientId);

  if (!port) {
    console.warn("[SW] No port for client, falling back:", evt.request.url);
    return fetch(evt.request);
  }

  return proxyThroughWS(evt.request, port, clientId);
}

async function proxyThroughWS(request, port, clientId) {
  const id = crypto.randomUUID();

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();

  const urlPath = new URL(request.url).pathname;

  console.log(`[SW][Client ${clientId}] → SharedWorker`, urlPath);

  const wrapper = {
    id,
    req: {
      url: urlPath,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body
    }
  };

  const responsePromise = new Promise(resolve => {
    function handler(evt) {
      if (evt.data?.id === id) {
        port.removeEventListener("message", handler);
        resolve(evt.data);
      }
    }
    port.addEventListener("message", handler);
  });

  port.postMessage(wrapper);

  const result = await responsePromise;

  return new Response(result.body, {
    status: result.status,
    headers: result.headers
  });
}
