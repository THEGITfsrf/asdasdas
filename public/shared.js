let ws;
let serverPubKey;
let aesKey;
let pending = new Map();
let handshakeResolve;
const handshakePromise = new Promise(r => (handshakeResolve = r));

const portMap = new WeakMap(); // map port → ID

const log = (port, ...a) => {
  const pid = portMap.get(port) || "unknown";
  console.log(`[SharedWorker][Port ${pid}]`, ...a);
};

const ab2b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
function b642ab(b64) {
  const binary = atob(b64);
  return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}

async function initWS() {
  log(null, "Opening WebSocket…");

  ws = new WebSocket("wss://asd-ywj6.onrender.com/ws");

  ws.onopen = async () => {
    log(null, "WebSocket OPEN.");

    const pem = await (await fetch("https://asd-ywj6.onrender.com/public.pem")).text();
    log(null, "Fetched public.pem:", pem.slice(0, 50) + "...");

    serverPubKey = await crypto.subtle.importKey(
      "spki",
      pemToArrayBuffer(pem),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"]
    );
    log(null, "RSA key imported.");

    aesKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    log(null, "AES session key generated.");

    const rawKey = await crypto.subtle.exportKey("raw", aesKey);
    const encrypted = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      serverPubKey,
      rawKey
    );

    log(null, "Sending RSA-encrypted AES key to server…");
    ws.send(JSON.stringify({
      type: "init",
      encryptedKeyBase64: ab2b64(encrypted)
    }));
  };

  ws.onmessage = async evt => {
    log(null, "WS message received:", evt.data);

    const msg = JSON.parse(evt.data);

    if (msg.type === "init_ack") {
      log(null, "Server acknowledged handshake.");
      handshakeResolve();
      return;
    }

    if (msg.type === "data") {
      log(null, "Encrypted backend payload received:", msg);

      const iv  = new Uint8Array(b642ab(msg.ivBase64));
      const ct  = new Uint8Array(b642ab(msg.payloadBase64));
      const tag = new Uint8Array(b642ab(msg.tagBase64));

      const full = new Uint8Array(ct.length + tag.length);
      full.set(ct);
      full.set(tag, ct.length);

      log(null, "Decrypting backend response…");
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        aesKey,
        full
      );

      const text = new TextDecoder().decode(decrypted);
      log(null, "Decrypted backend response:", text);

      const p = pending.get(msg.id);

      if (p) {
        log(p.port, "Resolving pending request:", msg.id);
        p.resolve({
          body: text,
          headers: msg.headers || {},
          status: msg.status || 200
        });

        pending.delete(msg.id);
      } else {
        log(null, "⚠️ No pending entry for message ID", msg.id);
      }
    }
  };

  ws.onerror = e => console.error("[SharedWorker] WS error:", e);

  ws.onclose = () => {
    log(null, "WebSocket closed. Reconnecting in 1s…");
    setTimeout(initWS, 1000);
  };
}

initWS();

async function sendToBackend(obj, port) {
  await handshakePromise;

  log(port, "Forwarding request to backend:", obj);

  const id = crypto.randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encoded = new TextEncoder().encode(JSON.stringify(obj));

  log(port, "Encrypting message with AES-GCM…");
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded
  );

  const buf = new Uint8Array(encrypted);

  const ciphertext = buf.slice(0, buf.length - 16);
  const tag = buf.slice(buf.length - 16);

  log(port, "Sending encrypted request to server:", { id });

  ws.send(JSON.stringify({
    type: "data",
    id,
    ivBase64: ab2b64(iv),
    payloadBase64: ab2b64(ciphertext),
    tagBase64: ab2b64(tag)
  }));

  return new Promise(resolve => {
    log(port, "Registering pending resolver for ID:", id);
    pending.set(id, { resolve, port });
  });
}

onconnect = e => {
  const port = e.ports[0];
  const pid = crypto.randomUUID();
  portMap.set(port, pid);

  log(port, "Port connected from SW → SharedWorker");

  port.onmessage = async evt => {
    const { id, req } = evt.data;

    log(port, "Received request from SW:", req);

    const rawResponse = await sendToBackend({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body
    }, port);

    log(port, "Sending response back to SW:", rawResponse);

    port.postMessage({
      id,
      body: rawResponse.body,
      status: rawResponse.status,
      headers: rawResponse.headers
    });
  };
};
