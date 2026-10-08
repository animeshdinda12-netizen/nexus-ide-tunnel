/* ═══════════════════════════════════════════════════════════════════════════
   NEXUS IDE — BROWSER TUNNEL ROUTER (Service Worker)
   ───────────────────────────────────────────────────────────────────────────
   Job: intercept top-level navigations to preview.html, expand the compressed
   ?t= payload in memory, and answer with the project's own document. The
   browser therefore treats the result as the page's real, top-level document —
   no iframe, no nested browsing context, no restrictive permissions policy.
   That is what lets RTCPeerConnection / PeerJS / getUserMedia and device
   permissions behave exactly as they do on a hand-written website.
   ═══════════════════════════════════════════════════════════════════════════ */

const SW_VERSION = 'nexus-tunnel-router-v1';
const REVOKED_DB = 'nexus-sw';
const REVOKED_STORE = 'revoked';
const LZ_CDNS = [
  'https://unpkg.com/lz-string@1.5.0/libs/lz-string.min.js',
  'https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js'
];

let lzReady = false;
let memoryRevoked = [];

/* ── 1 · LOAD THE DECODER ──────────────────────────────────────────────────
   importScripts is synchronous, so try each CDN in turn. If every CDN fails
   we simply stop intercepting navigations: preview.html decodes the payload
   itself, so the tunnel degrades gracefully instead of breaking.           */
try {
  for (let i = 0; i < LZ_CDNS.length && !lzReady; i++) {
    try {
      importScripts(LZ_CDNS[i]);
      lzReady = typeof LZString !== 'undefined' && typeof LZString.decompressFromEncodedURIComponent === 'function';
    } catch (e) {
      lzReady = false;
    }
  }
} catch (e) {
  lzReady = false;
}

/* ── 2 · REVOCATION LEDGER (IndexedDB) ─────────────────────────────────────
   localStorage is not reachable from a worker, so revocations are mirrored
   into IndexedDB by the page. The worker reads it on every request, which
   keeps a killed link dead across reloads and browser restarts.            */
function openLedger() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(REVOKED_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(REVOKED_STORE)) db.createObjectStore(REVOKED_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function ledgerHas(id) {
  if (!id) return false;
  if (memoryRevoked.indexOf(id) !== -1) return true;
  try {
    const db = await openLedger();
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(REVOKED_STORE, 'readonly');
        const get = tx.objectStore(REVOKED_STORE).get(id);
        get.onsuccess = () => { resolve(!!get.result); db.close(); };
        get.onerror = () => { resolve(false); db.close(); };
      } catch (e) { resolve(false); }
    });
  } catch (e) {
    return memoryRevoked.indexOf(id) !== -1;
  }
}

async function ledgerPut(id) {
  memoryRevoked = memoryRevoked.concat([id]).slice(-400);
  try {
    const db = await openLedger();
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(REVOKED_STORE, 'readwrite');
        tx.objectStore(REVOKED_STORE).put({ id: id, at: Date.now() });
        tx.oncomplete = () => { resolve(true); db.close(); };
        tx.onerror = () => { resolve(false); db.close(); };
      } catch (e) { resolve(false); }
    });
  } catch (e) { /* in-memory list still enforces it for this worker lifetime */ }
}

/* ── 3 · LIFECYCLE ─────────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
    } catch (e) { /* optional API */ }
    /* purge revocations older than 24h so the ledger cannot grow forever */
    try {
      const db = await openLedger();
      const cutoff = Date.now() - 86400000;
      const tx = db.transaction(REVOKED_STORE, 'readwrite');
      const store = tx.objectStore(REVOKED_STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        if (!cursor.value || !cursor.value.at || cursor.value.at < cutoff) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => db.close();
    } catch (e) { /* non-fatal */ }
    await self.clients.claim();
  })());
});

/* ── 4 · MESSAGES FROM THE PAGE ────────────────────────────────────────── */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'NEXUS_REVOKE' && data.id) {
    event.waitUntil(ledgerPut(data.id));
  } else if (data.type === 'NEXUS_SYNC_REVOKED' && Array.isArray(data.ids)) {
    memoryRevoked = data.ids.slice(-400);
    event.waitUntil(Promise.all(data.ids.slice(-400).map((id) => ledgerPut(id))));
  } else if (data.type === 'NEXUS_PING' && event.source) {
    event.source.postMessage({ type: 'NEXUS_PONG', version: SW_VERSION, lzReady: lzReady });
  }
});

/* ── 5 · RESPONSE BUILDERS ─────────────────────────────────────────────── */
function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Nexus-Router': SW_VERSION
    }
  });
}

function shell(title, glyph, message, extraMeta) {
  const css =
    'margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#020617;color:#e2e8f0;' +
    'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    'background-image:radial-gradient(900px 460px at 50% -12%,rgba(34,211,238,.15),transparent 62%)';
  const card =
    'width:min(660px,94vw);padding:30px;border-radius:20px;background:rgba(15,23,42,.82);' +
    'border:1px solid rgba(148,163,184,.18);backdrop-filter:blur(14px);box-shadow:0 36px 90px -38px #000';
  const pill =
    'display:inline-flex;gap:6px;padding:5px 11px;border-radius:999px;font-size:11px;font-weight:600;' +
    'letter-spacing:.08em;text-transform:uppercase;border:1px solid rgba(148,163,184,.22);' +
    'background:rgba(2,6,23,.6);color:#cbd5e1;margin-right:6px';
  const btn =
    'display:inline-block;margin-top:18px;padding:11px 18px;border-radius:11px;font-weight:700;font-size:13px;' +
    'color:#04212b;text-decoration:none;background:linear-gradient(135deg,#22d3ee,#34d399)';
  const ghost =
    'display:inline-block;margin:18px 0 0 8px;padding:11px 18px;border-radius:11px;font-weight:600;font-size:13px;' +
    'color:#cbd5e1;text-decoration:none;background:rgba(30,41,59,.6);border:1px solid rgba(71,85,105,.7)';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<meta name="robots" content="noindex,nofollow"/><title>' + title + ' · NEXUS Tunnel</title>' +
    '<style>html,body{height:100%}*{box-sizing:border-box}</style></head>' +
    '<body style="' + css + '"><div style="' + card + '">' +
    '<div style="font-size:34px;line-height:1">' + glyph + '</div>' +
    '<h1 style="margin:14px 0 6px;font-size:20px;letter-spacing:-.015em">' + title + '</h1>' +
    '<p style="margin:0;font-size:13.5px;line-height:1.7;color:#94a3b8">' + message + '</p>' +
    '<div style="margin-top:16px"><span style="' + pill + '">router: ' + SW_VERSION + '</span>' +
    (extraMeta ? '<span style="' + pill + '">' + extraMeta + '</span>' : '') + '</div>' +
    '<a style="' + btn + '" href="./index.html">← Back to NEXUS IDE</a>' +
    '</div></body></html>';
}

/* ── 6 · THE TUNNEL HANDLER ────────────────────────────────────────────── */
async function serveTunnel(url) {
  const payload = url.searchParams.get('t');
  const expParam = url.searchParams.get('e');
  const idParam = url.searchParams.get('id');
  const exp = expParam ? parseInt(expParam, 10) : NaN;

  /* 6a · revocation */
  if (idParam && await ledgerHas(idParam)) {
    return htmlResponse(shell(
      'This tunnel was revoked', '🛑',
      'The author killed this server, so the payload is no longer served. Ask them for a freshly generated link.',
      'revoked'
    ), 410);
  }

  /* 6b · expiry, checked before any decompression work */
  if (isFinite(exp) && Date.now() > exp) {
    const secs = Math.max(1, Math.round((Date.now() - exp) / 1000));
    return htmlResponse(shell(
      'This tunnel has expired', '⌛',
      'Tunnel links stay valid for <strong>15 minutes</strong>. This one lapsed ' + secs +
      ' second' + (secs === 1 ? '' : 's') + ' ago. Spin up a new server in the IDE for a fresh link.',
      'expired'
    ), 410);
  }

  /* 6c · decode */
  if (!payload) return htmlResponse(shell('Nothing to preview', '🛰️',
    'This page renders a project through the NEXUS Browser Tunnel. Generate a link from the IDE first.'), 404);

  let envelope = null;
  try {
    const json = LZString.decompressFromEncodedURIComponent(payload);
    if (!json) throw new Error('decompressor returned an empty string');
    envelope = JSON.parse(json);
  } catch (e) {
    return htmlResponse(shell(
      'Corrupted tunnel payload', '🧩',
      'The <code>?t=</code> parameter could not be decoded. Long links are often truncated by chat apps, mail clients ' +
      'and link shorteners — copy the link straight from the IDE instead.',
      'decode failed'
    ), 400);
  }

  if (!envelope || typeof envelope.h !== 'string' || !envelope.h) {
    return htmlResponse(shell('Payload has no document', '🧩',
      'The link decoded but carried no HTML body, which usually means it was truncated in transit. Regenerate the tunnel.'), 400);
  }

  /* 6d · the envelope carries its own expiry — trust the later of the two */
  if (envelope.e && Date.now() > Number(envelope.e)) {
    return htmlResponse(shell('This tunnel has expired', '⌛',
      'The embedded timestamp is in the past, so the document was discarded before it could be served.', 'expired'), 410);
  }
  if (envelope.id && await ledgerHas(envelope.id)) {
    return htmlResponse(shell('This tunnel was revoked', '🛑',
      'The author killed this server. Ask them for a freshly generated link.', 'revoked'), 410);
  }

  /* 6e · serve the project as the navigation response itself */
  return htmlResponse(envelope.h, 200);
}

/* ── 7 · FETCH ROUTING ─────────────────────────────────────────────────────
   Only top-level navigations to preview.html are touched. Subresources,
   fetches and the IDE itself pass straight through to the network.        */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;
  if (!lzReady) return;                       /* no decoder → preview.html decodes itself */

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  const isNavigation = req.mode === 'navigate' || req.destination === 'document';
  if (!isNavigation) return;
  if (url.origin !== self.location.origin) return;
  if (!/\/preview\.html$/i.test(url.pathname)) return;
  if (!url.searchParams.get('t')) return;

  event.respondWith(
    serveTunnel(url).catch((err) => htmlResponse(shell(
      'Tunnel router error', '⚠️',
      'An unexpected failure occurred while unpacking the payload. The raw message is below.',
      'router error'
    ).replace('</p>', '</p><pre style="margin:16px 0 0;padding:14px;border-radius:12px;background:#020617;' +
      'border:1px solid rgba(148,163,184,.16);font-size:11.5px;color:#fda4af;white-space:pre-wrap">' +
      String((err && err.message) || err).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) +
      '</pre>'), 500))
  );
});
