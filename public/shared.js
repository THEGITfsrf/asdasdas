// shared.js (SharedWorker)

let ws;
let aesKey;
const pending = new Map();
let handshakeResolve;

const handshake = new Promise(r => handshakeResolve = r);

onconnect = (e) => {
  const port = e.ports[0];
  port.start();

  port.onmessage = async (ev) => {
    const msg = ev.data;

    if (msg.type === "init") {
      ws = new WebSocket(msg.wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onmessage = async (ev) => {
        const data = JSON.parse(ev.data);

        if (data.type === "init_ack") {
          handshakeResolve();
          return;
        }

        if (data.type !== "data") return;

        const iv  = Uint8Array.from(atob(data.ivBase64), c => c.charCodeAt(0));
        const ct  = Uint8Array.from(atob(data.payloadBase64), c => c.charCodeAt(0));
        const tag = Uint8Array.from(atob(data.tagBase64), c => c.charCodeAt(0));

        try {
          const key = await crypto.subtle.importKey(
            "raw", aesKey, { name: "AES-GCM" }, false, ["decrypt"]
          );

          const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv, additionalData: null, tagLength: 128 },
            key,
            new Uint8Array([...ct, ...tag])
          );

          const text = new TextDecoder().decode(plain);
          const json = JSON.parse(text);

          pending.get(data.id)?.resolve(json);
          pending.delete(data.id);

        } catch (err) {
          pending.get(data.id)?.reject(err);
          pending.delete(data.id);
        }
      };

      return;
    }

    if (msg.type === "setKey") {
      aesKey = msg.key;
      return;
    }

    if (msg.type === "fetch") {
      await handshake;

      const id = crypto.randomUUID();
      pending.set(id, msg);

      ws.send(JSON.stringify({
        type: "data",
        id,
        ...msg.packet
      }));
    }
  };
};
