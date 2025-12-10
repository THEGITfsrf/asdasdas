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
  const url = new URL(evt.request.url);

  if (url.pathname === "/" ||
      url.pathname.endsWith("sw.js") ||
      url.pathname.endsWith("shared.js") ||
      url.pathname.endsWith("public.pem")) {
    console.log("[SW] Not proxying:", url.pathname);
    return;
  }

  console.log("[SW] Intercepted fetch:", url.pathname, "method:", evt.request.method);
  evt.respondWith(proxyThroughWS(evt.request));
});

async function proxyThroughWS(request) {
  if (!sharedPort) {
    console.warn("[SW] No SharedWorker port, falling back to network for:", request.url);
    const fallbackResp = await fetch(request);
    console.log("[SW] Fetched from network:", request.url, "status:", fallbackResp.status);
    return fallbackResp;
  }

  const id = crypto.randomUUID();
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();

  console.log("[SW] Forwarding to SharedWorker:", request.url, "method:", request.method, "body:", body);

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
        console.log("[SW] Received response from SharedWorker for:", request.url);
        resolve(evt.data);
      }
    }
    sharedPort.addEventListener("message", handler);
  });

  sharedPort.postMessage(wrapper);

  const result = await responsePromise;

  console.log("[SW] Returning response to page for:", request.url, "status:", result.status);

  return new Response(result.body, {
    status: result.status,
    headers: result.headers
  });
}
