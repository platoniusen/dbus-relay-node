#!/usr/bin/env node
/**
 * Notify relay: Unix socket -> org.freedesktop.Notifications (session D-Bus)
 * Accepts either:
 *  - JSON: {"summary":"Title","body":"Body","urgency":"low|normal|critical","icon":"dialog-information","timeout":5000,"app":"notify-relay"}
 *  - Plain: "Title|Body"
 *
 * Socket path: /run/user/<uid>/notify.sock  (created with 0666 by default; see notes)
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const { execSync } = require('child_process');
const { Variant, sessionBus } = require('dbus-next');

const UID = process.getuid();
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`;
const DEFAULT_SOCK = `/tmp/notify-${UID}.sock`;             // <— new default
const SOCK_PATH = process.env.NOTIFY_RELAY_SOCK || DEFAULT_SOCK;

// ---- Helpers ---------------------------------------------------------------
function parsePayload(buf) {
  const text = buf.toString('utf8').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try { return JSON.parse(text); } catch { /* fall through */ }
  }
  const [summary, body] = text.split('|', 2);
  return { summary: (summary || '').trim(), body: body ? body.trim() : '' };
}

function urgencyToHint(u) {
  // org.freedesktop.Notifications "urgency" is a byte hint (0,1,2)
  const map = { low: 0, normal: 1, critical: 2 };
  if (u == null) return undefined;
  const key = String(u).toLowerCase();
  return map[key] ?? 1;
}

async function notify(bus, payload) {
  const summary = payload.summary || payload.title || '(no title)';
  let body = payload.body || '';
  const icon = payload.icon || '';
  const app = payload.app || 'notify-relay';
  const expire = Number.isFinite(payload.timeout) ? Math.trunc(payload.timeout) : -1;

  // If we find a path (/ x 2) in the body, let's just use the last part as the body
  if (body && body.includes('/')) {
    const parts = body.split(/\s+/);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].includes('/')) {
        const subparts = parts[i].split('/');
        const lastPart = subparts[subparts.length - 1];
        if (lastPart) {
          // Use this as the body
          body = lastPart;
          break;
        }
      }
    }
  }

  body = body.trim();

  const hints = {};
  const urg = urgencyToHint(payload.urgency);
  if (urg !== undefined) hints['urgency'] = new Variant('y', urg);
  if (payload.category) hints['category'] = new Variant('s', String(payload.category));
  if (payload.sound === false) hints['sound-file'] = new Variant('s', ''); // simplistic mute

  const obj = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
  const iface = obj.getInterface('org.freedesktop.Notifications');

  // signature: Notify(s app_name, u replaces_id, s app_icon, s summary, s body, as actions, a{sv} hints, i expire_timeout) → (u id)
  const notifyState = iface.Notify(app, 0, icon, summary, body, [], hints, expire);

  // Call the fallback sound if sound is not disabled or specified something else.
  if (!payload.sound) {
    execSync(`aplay -d 3 ${__dirname}/825639__1love__1love_fx_winner.wav`, {
      timeout: 5000,
    });
  }

  return notifyState;
}

// ---- Main: create socket + D-Bus session ----------------------------------
(async () => {
  // Ensure single instance: remove stale socket
  try { fs.unlinkSync(SOCK_PATH); } catch (_) {}

  const bus = sessionBus(); // uses DBUS_SESSION_BUS_ADDRESS from environment under user
  bus.on('error', (e) => console.error('D-Bus error:', e));

  const server = net.createServer(async (socket) => {
    const chunks = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', async () => {
      try {
        const payload = parsePayload(Buffer.concat(chunks));
        if (!payload || !payload.summary) throw new Error('invalid payload');
        await notify(bus, payload);
      } catch (err) {
        // don’t crash the server on bad input
        console.error('notify error:', err?.message || err);
      } finally {
        socket.end();
      }
    });
  });

  server.listen(SOCK_PATH, () => {
    try {
      // Default open to everyone (easy). If you want to restrict, see “Security” below.
      fs.chmodSync(SOCK_PATH, 0o666);
    } catch (_) {}
    console.log(`notify-relay listening on ${SOCK_PATH}`);
  });

  // Clean up on exit
  const cleanup = () => { try { fs.unlinkSync(SOCK_PATH); } catch (_) {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
})();
