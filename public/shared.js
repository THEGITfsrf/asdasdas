let ws;
let serverPubKey;
let aesKey;
let pending = new Map();
let handshakeResolve;
const handshakePromise = new Promise(r => (handshakeResolve = r));

const portMap = new WeakMap(); // port -> portId

const log = (port, ...args) => {
  const pid = port ? portMap.get(port) : "WS";
  console.log(`[SharedWorker][${pid}]`, ...args);
};

const ab2b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b642ab = b64 =>
  Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;

function pemToArrayBuffer(pem) {
  return Uint8Array.from(
    atob(pem.replace(/-----.*-----|\s+/g, "")),
    c => c.charCodeAt(0)
  ).buffer;
}

/* ---------- WebSocket + Crypto ---------- */

async function initWS() {
  ws = new WebSocket("wss://asd-ywj6.onrender.com/ws");

  ws.onopen = async () => {
    const pem = await (await fetch("https://asd-ywj6.onrender.com/public.pem")).text();

    serverPubKey = await crypto.subtle.importKey(
      "spki",
      pemToArrayBuffer(pem),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"]
    );

    aesKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    const rawKey = await crypto.subtle.exportKey("raw", aesKey);
    const encrypted = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      serverPubKey,
      rawKey
    );

    ws.send(JSON.stringify({
      type: "init",
      encryptedKeyBase64: ab2b64(encrypted)
    }));
  };

  ws.onmessage = async evt => {
    const msg = JSON.parse(evt.data);

    if (msg.type === "init_ack") {
      handshakeResolve();
      return;
    }

    if (msg.type === "data") {
      const iv = new Uint8Array(b642ab(msg.ivBase64));
      const ct = new Uint8Array(b642ab(msg.payloadBase64));
      const tag = new Uint8Array(b642ab(msg.tagBase64));

      const full = new Uint8Array(ct.length + tag.length);
      full.set(ct);
      full.set(tag, ct.length);

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          aesKey,
          full
        );

        const text = new TextDecoder().decode(decrypted);

        const p = pending.get(msg.id);
        if (!p) return;

        pending.delete(msg.id);
        p.resolve({
          body: text,
          headers: msg.headers || {},
          status: msg.status || 200
        });
      } catch (e) {
        console.error("[SharedWorker] Decrypt failed", e);
      }
    }
  };

  ws.onclose = () => setTimeout(initWS, 1000);
}

initWS();

/* ---------- SharedWorker Ports ---------- */

async function sendToBackend(obj, port) {
  await handshakePromise;

  const id = crypto.randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(obj));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded
  );

  const buf = new Uint8Array(encrypted);

  ws.send(JSON.stringify({
    type: "data",
    id,
    ivBase64: ab2b64(iv),
    payloadBase64: ab2b64(buf.slice(0, -16)),
    tagBase64: ab2b64(buf.slice(-16))
  }));

  return new Promise(resolve => {
    pending.set(id, { resolve, port });
