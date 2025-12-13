let ws;
let serverPubKey;
let aesKey;
let pending = new Map();
let handshakeResolve;
const handshakePromise = new Promise(r => (handshakeResolve = r));

const log = (...a) => console.log("[SharedWorker]", ...a);

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
  log("Opening WebSocket…");

  ws = new WebSocket("wss://asd-ywj6.onrender.com/ws");

  ws.onopen = async () => {
    log("WebSocket OPEN.");

    log("Fetching server public key from:", "https://asd-ywj6.onrender.com/public.pem");
    const pem = await (await fetch("https://asd-ywj6.onrender.com/public.pem")).text();
    log("Fetched public.pem:", pem.slice(0, 50) + "...");

    log("Importing RSA public key…");
    serverPubKey = await crypto.subtle.importKey(
      "spki",
      pemToArrayBuffer(pem),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"]
    );
    log("RSA key imported.");

    log("Generating AES session key…");
    aesKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    log("AES session key generated.");

    const rawKey = await crypto.subtle.exportKey("raw", aesKey);
    const encrypted = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      serverPubKey,
      rawKey
    );

    log("Sending RSA-encrypted AES key to server…");
    ws.send(JSON.stringify({
      type: "init",
      encryptedKeyBase64: ab2b64(encrypted)
    }));
  };

  ws.onmessage = async evt => {
    log("WS message received:", evt.data);

    const msg = JSON.parse(evt.data);

    if (msg.type === "init_ack") {
      log("Server acknowledged handshake.");
      handshakeResolve();
      return;
    }

    if (msg.type === "data") {
      log("Encrypted backend payload received:", msg);

      const iv  = new Uint8Array(b642ab(msg.ivBase64));
      const ct  = new Uint8Array(b642ab(msg.payloadBase64));
      const tag = new Uint8Array(b642ab(msg.tagBase64));

      const full = new Uint8Array(ct.length + tag.length);
      full.set(ct);
      full.set(tag, ct.length);

      log("Decrypting backend response…");
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        aesKey,
        full
      );

      const text = new TextDecoder().decode(decrypted);
      log("Decrypted backend response:", text);

      const p = pending.get(msg.id);

      if (p) {
        log("Resolving pending request:", msg.id);
        p.resolve({
          body: text,
          headers: msg.headers || {},
          status: msg.status || 200
        });

        pending.delete(msg.id);
      } else {
        log("⚠️ No pending entry for message ID", msg.id);
      }
    }
  };

  ws.onerror = e => console.error("[SharedWorker] WS error:", e);

  ws.onclose = () => {
    log("WebSocket closed. Reconnecting in 1s…");
    setTimeout(initWS, 1000);
  };
}

initWS();

async function sendToBackend(obj) {
  await handshakePromise;

  log("Forwarding request to backend:", obj);

  const id = crypto.randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encoded = new TextEncoder().encode(JSON.stringify(obj));

  log("Encrypting message with AES-GCM…");
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded
  );

  const buf = new Uint8Array(encrypted);

  const ciphertext = buf.slice(0, buf.length - 16);
  const tag = buf.slice(buf.length - 16);

  log("Sending encrypted request to server:", { id });

  ws.send(JSON.stringify({
    type: "data",
    id,
    ivBase64: ab2b64(iv),
    payloadBase64: ab2b64(ciphertext),
    tagBase64: ab2b64(tag)
  }));

  return new Promise(resolve => {
    log("Registering pending resolver for ID:", id);
    pending.set(id, { resolve });
  });
}

onconnect = e => {
  const port = e.ports[0];
  log("Port connected from SW → SharedWorker");

  port.onmessage = async evt => {
    const { id, req } = evt.data;

    log("Received request from SW:", req);

    const rawResponse = await sendToBackend({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body
    });

    log("Sending response back to SW:", rawResponse);

    port.postMessage({
      id,
      body: rawResponse,
      status: 200,
      headers: { "Content-Type": "text/html" }
    });
  };
};
