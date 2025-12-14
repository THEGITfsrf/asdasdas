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

  // Skip SW, SharedWorker, public key, and root
  if (
    url.pathname === "/" ||
    url.pathname.endsWith("sw.js") ||
    url.pathname.endsWith("shared.js") ||
    url.pathname.endsWith("public.pem")
  ) {
    console.log("[SW] Not proxying:", url.pathname);
    return;
  }

  console.log("[SW] Intercepted fetch:", url.pathname, "method:", evt.request.method);
  evt.respondWith(proxyThroughWS(evt.request));
});

async function proxyThroughWS(request) {
  if (!sharedPort) {
    console.warn("[SW] No SharedWorker port; falling back to network for:", request.url);
    return fetch(request);
  }

  const id = crypto.randomUUID();

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();

  const urlPath = new URL(request.url).pathname; // <-- ONLY the path

  console.log("[SW] Forwarding to SharedWorker:", urlPath, "method:", request.method, "body:", body);

  const wrapper = {
    id,
    req: {
      url: urlPath,      // send only pathname
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body
    }
  };

  const responsePromise = new Promise(resolve => {
    function handler(evt) {
      if (evt.data?.id === id) {
        sharedPort.removeEventListener("message", handler);

        console.log("[SW] Received response from SharedWorker for:", urlPath);
        console.log("[SW] Response status:", evt.data.status);
        console.log("[SW] Response headers:", evt.data.headers);
        console.log("[SW] Response body snippet:", evt.data.body?.slice(0, 100), "...");

        resolve(evt.data);
      }
    }
    sharedPort.addEventListener("message", handler);
  });

  sharedPort.postMessage(wrapper);

  const result = await responsePromise;

  console.log("[SW] Returning response to page for:", urlPath, "status:", result.status);

  return new Response(result.body, {
    status: result.status,
    headers: result.headers
  });
}
