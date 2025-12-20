const portsByClient = new Map();
const readyByClient = new Map();

self.addEventListener("install", evt => {
  console.log("[SW] Installing service worker...");
  self.skipWaiting();
});

self.addEventListener("activate", evt => console.log("[SW] Activated"));

self.addEventListener("message", evt => {
  if (evt.data?.type === "connect-shared-worker") {
    const clientId = evt.clientId;
    const port = evt.ports[0];
    port.start();
    portsByClient.set(clientId, port);
    readyByClient.set(clientId, Promise.resolve());
    console.log(`[SW] Port registered for client ${clientId}`);
  }
});

self.addEventListener("fetch", evt => {
  console.log("[SW] Fetch intercepted:", evt.request.method, evt.request.url);
  evt.respondWith(handleFetch(evt));
});

async function handleFetch(evt) {
  const url = new URL(evt.request.url);

  if (url.pathname.endsWith("sw.js") || url.pathname.endsWith("shared.js") || url.pathname.endsWith("public.pem")) {
    console.log("[SW] Bypassing SW for core file:", url.pathname);
    return fetch(evt.request);
  }

  const clientId = evt.clientId;
  const port = portsByClient.get(clientId);
  const ready = readyByClient.get(clientId);

  if (!port || !ready) {
    console.warn("[SW] No port ready for client:", clientId, "- falling back to network");
    return fetch(evt.request);
  }

  try {
    console.log("[SW] Proxying request through SharedWorker for client:", clientId);
    await ready;
    return proxyThroughSW(evt.request, port, clientId);
  } catch (err) {
    console.error("[SW] Fetch proxy error:", err);
    return fetch(evt.request);
  }
}

async function proxyThroughSW(request, port, clientId) {
  const id = crypto.randomUUID();
  console.log(`[SW] Preparing request ${id} for SharedWorker:`, request.method, request.url);

  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.arrayBuffer();

  const wrapper = {
    id,
    req: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: body ? Array.from(new Uint8Array(body)) : null
    }
  };

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.removeEventListener("message", handler);
      console.error(`[SW] Timeout for request ${id} from SharedWorker`);
      reject(new Error("Timeout from SharedWorker"));
    }, 15000);

    function handler(evt) {
      if (evt.data?.id === id) {
        clearTimeout(timeout);
        port.removeEventListener("message", handler);
        console.log(`[SW] Response received for request ${id} from SharedWorker`);
        resolve(evt.data);
      }
    }

    port.addEventListener("message", handler);
  });

  console.log(`[SW] Sending request ${id} to SharedWorker`);
  port.postMessage(wrapper);

  try {
    const result = await responsePromise;
    const headers = new Headers(result.headers || {});
    const resBody = result.body ? new Uint8Array(result.body) : null;
    console.log(`[SW] Returning proxied response for request ${id}, status: ${result.status}`);
    return new Response(resBody, { status: result.status || 200, headers });
  } catch (err) {
    console.error("[SW] Proxy error:", err);
    return fetch(request);
  }
}
