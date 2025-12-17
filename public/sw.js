const portsByClient = new Map(); // clientId -> MessagePort

self.addEventListener("install", evt => {
  console.log("[SW] Installing...");
  self.skipWaiting();
});

self.addEventListener("activate", evt => {
  console.log("[SW] Activating...");
});

// Receive the SharedWorker port from a page
self.addEventListener("message", evt => {
  if (evt.data?.type === "connect-shared-worker") {
    const clientId = evt.source.id || evt.clientId;
    const port = evt.ports[0];

    port.start(); // ✅ Start the port
    portsByClient.set(clientId, port);

    console.log(`[SW] Registered SharedWorker port for client ${clientId}`);
  }
});

// Cleanup / fetch handling
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  if (
    url.pathname.endsWith("sw.js") ||
    url.pathname.endsWith("shared.js") ||
    url.pathname.endsWith("public.pem")
  ) return;

  if (evt.request.mode === "navigate") {
    evt.respondWith(handleNavigation(evt));
    return;
  }

  evt.respondWith(handleFetch(evt));
});

async function handleNavigation(evt) {
  return handleRequest(evt);
}

async function handleFetch(evt) {
  return handleRequest(evt);
}

async function handleRequest(evt) {
  const clientId = evt.clientId;
  const port = portsByClient.get(clientId);

  if (!port) {
    console.warn("[SW] No SharedWorker port for client, falling back:", evt.request.url);
    return fetch(evt.request);
  }

  return proxyThroughSW(evt.request, port, clientId);
}

// Proxy request through SharedWorker
async function proxyThroughSW(request, port, clientId) {
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

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.removeEventListener("message", handler);
      reject(new Error("Timeout waiting for SharedWorker"));
    }, 5000);

    function handler(evt) {
      if (evt.data?.id === id) {
        clearTimeout(timeout);
        port.removeEventListener("message", handler);
        resolve(evt.data);
      }
    }

    port.addEventListener("message", handler);
  });

  port.postMessage(wrapper);

  try {
    const result = await responsePromise;
    return new Response(result.body, {
      status: result.status,
      headers: result.headers
    });
  } catch (err) {
    console.error("[SW] Proxy error:", err);
    return fetch(request);
  }
}
