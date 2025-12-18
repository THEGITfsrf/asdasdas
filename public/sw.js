const portsByClient = new Map(); // clientId -> MessagePort

self.addEventListener("install", evt => self.skipWaiting());
self.addEventListener("activate", evt => console.log("[SW] Activated"));

self.addEventListener("message", evt => {
  if (evt.data?.type === "connect-shared-worker") {
    const clientId = evt.source.id || evt.clientId;
    const port = evt.ports[0];
    port.start(); // must start the port
    portsByClient.set(clientId, port);
    console.log(`[SW] Port registered for client ${clientId}`);
  }
});

self.addEventListener("fetch", evt => {
  evt.respondWith(handleFetch(evt));
});

async function handleFetch(evt) {
  const url = new URL(evt.request.url);

  // Never proxy SW, SharedWorker, or keys
  if (url.pathname.endsWith("sw.js") || url.pathname.endsWith("shared.js") || url.pathname.endsWith("public.pem")) {
    return fetch(evt.request);
  }

  const clientId = evt.clientId;
  const port = portsByClient.get(clientId);

  if (!port) {
    console.warn("[SW] No port yet, fetching normally:", url.href);
    return fetch(evt.request);
  }

  return proxyThroughSW(evt.request, port, clientId);
}

async function proxyThroughSW(request, port, clientId) {
  const id = crypto.randomUUID();
  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.arrayBuffer(); // binary-safe

  const wrapper = {
    id,
    req: {
      url: new URL(request.url).pathname,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: body ? Array.from(new Uint8Array(body)) : null
    }
  };

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.removeEventListener("message", handler);
      reject(new Error("Timeout from SharedWorker"));
    }, 10000); // 10s for big files

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
    const headers = new Headers(result.headers || {});
    const resBody = result.body ? new Uint8Array(result.body) : null;
    return new Response(resBody, { status: result.status || 200, headers });
  } catch (err) {
    console.error("[SW] Proxy error:", err);
    return fetch(request); // fallback
  }
}
