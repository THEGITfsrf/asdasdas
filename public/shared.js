let ws, aesKey;
let pending = new Map();
let handshakeResolve;
const handshakePromise = new Promise(r => handshakeResolve = r);
const portMap = new WeakMap();
const ports = new Set();

const log = (port, ...args) => console.log(`[SharedWorker][${portMap.get(port) || "WS"}]`, ...args);

// Base64 ↔ ArrayBuffer
function ab2b64(buf){ return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b642ab(b64){ return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer; }

// Safe PEM → ArrayBuffer
function pemToArrayBuffer(pem) {
  let b64 = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, "");
  b64 = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}

async function initWS(){
  ws = new WebSocket("wss://asd-ywj6.onrender.com/ws");

  ws.onopen = async ()=>{
    const pem = await (await fetch("https://asd-ywj6.onrender.com/public.pem")).text();
    const serverPubKey = await crypto.subtle.importKey(
      "spki", pemToArrayBuffer(pem),
      {name:"RSA-OAEP", hash:"SHA-256"},
      false, ["encrypt"]
    );

    aesKey = await crypto.subtle.generateKey({name:"AES-GCM", length:256}, true, ["encrypt","decrypt"]);
    const rawKey = await crypto.subtle.exportKey("raw", aesKey);
    const encrypted = await crypto.subtle.encrypt({name:"RSA-OAEP"}, serverPubKey, rawKey);

    ws.send(JSON.stringify({type:"init", encryptedKeyBase64: ab2b64(encrypted)}));
  };

  ws.onmessage = async evt=>{
    const msg = JSON.parse(evt.data);

    if(msg.type==="init_ack"){ 
      handshakeResolve();
      broadcastToPorts({type:"handshake_done"});
      return; 
    }

    if(msg.type!=="data") return;

    const iv = new Uint8Array(b642ab(msg.ivBase64));
    const ct = new Uint8Array(b642ab(msg.payloadBase64));
    const tag = new Uint8Array(b642ab(msg.tagBase64));
    const full = new Uint8Array(ct.length+tag.length);
    full.set(ct); full.set(tag, ct.length);

    try {
      const decrypted = await crypto.subtle.decrypt({name:"AES-GCM", iv}, aesKey, full);
      const data = JSON.parse(new TextDecoder().decode(decrypted));
      const p = pending.get(msg.id); if(!p) return;
      pending.delete(msg.id);
      p.resolve(data);
    } catch(e){ console.error("[SharedWorker] Decrypt failed", e); }
  };

  ws.onclose = ()=>setTimeout(initWS, 1000);
}

initWS();

function broadcastToPorts(msg){
  ports.forEach(port => port.postMessage(msg));
}

async function sendToBackend(obj, port){
  await handshakePromise;
  const id = crypto.randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(obj));
  const encrypted = await crypto.subtle.encrypt({name:"AES-GCM", iv}, aesKey, encoded);
  const buf = new Uint8Array(encrypted);

  ws.send(JSON.stringify({
    type:"data",
    id,
    ivBase64: ab2b64(iv),
    payloadBase64: ab2b64(buf.slice(0,-16)),
    tagBase64: ab2b64(buf.slice(-16))
  }));

  return new Promise(resolve=>pending.set(id,{resolve, port}));
}

onconnect = e=>{
  const port = e.ports[0];
  const pid = crypto.randomUUID();
  portMap.set(port, pid);
  ports.add(port);
  port.start();
  log(port,"Connected");

  port.onmessage = async evt=>{
    const {id, req} = evt.data;
    try {
      const resp = await sendToBackend(req, port);
      port.postMessage({...resp, id});
    } catch(e){
      console.error("[SharedWorker] Error", e);
      port.postMessage({id, body:null, headers:{}, status:500});
    }
  };

  port.onclose = ()=>ports.delete(port);
};
