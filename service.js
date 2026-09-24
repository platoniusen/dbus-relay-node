#!/usr/bin/env node
/**
 * D-Bus Notification Relay Service
 *
 * A Unix socket server that relays notifications to the
 * freedesktop.org Notifications D-Bus interface with optional audio feedback.
 *
 * Accepts either:
 *  - JSON: {"summary":"Title","body":"Body","urgency":"low|normal|critical","icon":"dialog-information","timeout":5000,"app":"notify-relay","sound":false,"volume":50}
 *  - Plain: "Title|Body"
 *
 * Environment Variables:
 *  - NOTIFY_RELAY_SOCK: Unix socket path (default: /tmp/notify-<uid>.sock)
 *  - NOTIFY_RELAY_SOUND: Path to sound file (default: ./825639__1love__1love_fx_winner.wav)
 *  - NOTIFY_RELAY_SOUND_ENABLED: Enable/disable sound (default: true)
 *  - NOTIFY_RELAY_SOUND_TIMEOUT: Sound playback timeout in ms (default: 5000)
 *  - NOTIFY_RELAY_SOUND_VOLUME: Sound volume in percent, 0-100 (default: 25)
 *  - NOTIFY_RELAY_SOCKET_PERMISSIONS: Socket file permissions (default: 0666)
 *  - NOTIFY_RELAY_LOG_LEVEL: Logging level: debug|info|warn|error (default: info)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { Variant, sessionBus } = require('@particle/dbus-next');

// ---- Configuration ---------------------------------------------------------
const UID = process.getuid();
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`;
const DEFAULT_SOCK = `/tmp/notify-${UID}.sock`;
const SOCK_PATH = process.env.NOTIFY_RELAY_SOCK || DEFAULT_SOCK;
const SOUND_FILE = process.env.NOTIFY_RELAY_SOUND || path.join(__dirname, '825639__1love__1love_fx_winner.wav');
const SOUND_ENABLED = process.env.NOTIFY_RELAY_SOUND_ENABLED !== 'false';
const SOUND_TIMEOUT = parseInt(process.env.NOTIFY_RELAY_SOUND_TIMEOUT, 10) || 5000;
const SOUND_VOLUME = parseVolume(process.env.NOTIFY_RELAY_SOUND_VOLUME) ?? 25;
const SOCKET_PERMISSIONS = parseInt(process.env.NOTIFY_RELAY_SOCKET_PERMISSIONS, 8) || 0o666;
const LOG_LEVEL = (process.env.NOTIFY_RELAY_LOG_LEVEL || 'info').toLowerCase();

// Parse a volume percentage (0-100); returns undefined for missing/invalid input
function parseVolume(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(0, n));
}

// ---- Logging ---------------------------------------------------------------
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] >= currentLogLevel) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}]`, ...args);
  }
}

const logger = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args)
};

// ---- Helpers ---------------------------------------------------------------
function parsePayload(buf) {
  const text = buf.toString('utf8').trim();
  if (!text) {
    logger.debug('Received empty payload');
    return null;
  }

  // Try JSON parsing first
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      logger.debug('Parsed JSON payload:', parsed);
      return parsed;
    } catch (err) {
      logger.warn('Failed to parse JSON, falling back to plain text:', err.message);
    }
  }

  // Fallback to plain text format "Title|Body"
  const [summary, body] = text.split('|', 2);
  const payload = {
    summary: (summary || '').trim(),
    body: body ? body.trim() : ''
  };
  logger.debug('Parsed plain text payload:', payload);
  return payload;
}

function urgencyToHint(u) {
  // org.freedesktop.Notifications "urgency" is a byte hint (0,1,2)
  const map = { low: 0, normal: 1, critical: 2 };
  if (u == null) return undefined;
  const key = String(u).toLowerCase();
  const result = map[key] ?? 1;
  logger.debug(`Urgency mapping: "${u}" -> ${result}`);
  return result;
}

// Scale the PCM samples of a WAV buffer in place by `gain` (0..1).
// Volume is applied to the audio data itself because PulseAudio/PipeWire
// stream-restore overrides any per-stream volume the player requests.
// Returns false if the WAV format is not supported.
function scaleWav(buf, gain) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return false;

  let format, bits, offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (id === 'fmt ') {
      format = buf.readUInt16LE(start);
      bits = buf.readUInt16LE(start + 14);
      // WAVE_FORMAT_EXTENSIBLE: real format is the first 2 bytes of the sub-format GUID
      if (format === 0xfffe) format = buf.readUInt16LE(start + 24);
    } else if (id === 'data') {
      const end = Math.min(start + size, buf.length);
      if (format === 1 && bits === 16) {
        for (let i = start; i + 2 <= end; i += 2) buf.writeInt16LE(Math.round(buf.readInt16LE(i) * gain), i);
      } else if (format === 1 && bits === 24) {
        for (let i = start; i + 3 <= end; i += 3) buf.writeIntLE(Math.round(buf.readIntLE(i, 3) * gain), i, 3);
      } else if (format === 1 && bits === 32) {
        for (let i = start; i + 4 <= end; i += 4) buf.writeInt32LE(Math.round(buf.readInt32LE(i) * gain), i);
      } else if (format === 3 && bits === 32) {
        for (let i = start; i + 4 <= end; i += 4) buf.writeFloatLE(buf.readFloatLE(i) * gain, i);
      } else {
        return false;
      }
      return true;
    }
    offset = start + size + (size % 2); // chunks are word aligned
  }
  return false;
}

function playSound(soundPath, volume = SOUND_VOLUME) {
  if (!SOUND_ENABLED) {
    logger.debug('Sound playback disabled');
    return;
  }

  if (!fs.existsSync(soundPath)) {
    logger.warn(`Sound file not found: ${soundPath}`);
    return;
  }

  try {
    const wav = fs.readFileSync(soundPath);
    // Cubic curve, matching how desktop volume sliders map percent to loudness
    const gain = Math.pow(volume / 100, 3);
    if (!scaleWav(wav, gain)) {
      logger.warn(`Unsupported WAV format, playing at original volume: ${soundPath}`);
    }
    logger.debug(`Playing sound: ${soundPath} at ${volume}%`);
    execFileSync('aplay', ['-q', '-d', '3', '-'], {
      input: wav,
      timeout: SOUND_TIMEOUT,
      stdio: ['pipe', 'ignore', 'ignore']
    });
  } catch (err) {
    logger.error('Failed to play sound:', err.message);
  }
}

async function notify(bus, payload) {
  const summary = payload.summary || payload.title || '(no title)';
  let body = payload.body || '';
  const icon = payload.icon || '';
  const app = payload.app || 'notify-relay';
  const expire = Number.isFinite(payload.timeout) ? Math.trunc(payload.timeout) : -1;

  // Extract filename from path if present (simplify long paths)
  if (body && body.includes('/')) {
    const parts = body.split(/\s+/);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].includes('/')) {
        const subparts = parts[i].split('/');
        const lastPart = subparts[subparts.length - 1];
        if (lastPart) {
          body = lastPart;
          break;
        }
      }
    }
  }

  body = body.trim();

  // Build D-Bus hints
  const hints = {};
  const urg = urgencyToHint(payload.urgency);
  if (urg !== undefined) hints['urgency'] = new Variant('y', urg);
  if (payload.category) hints['category'] = new Variant('s', String(payload.category));
  if (payload.sound === false) hints['sound-file'] = new Variant('s', '');

  logger.debug('Sending notification:', { app, summary, body, icon, expire });

  try {
    const obj = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
    const iface = obj.getInterface('org.freedesktop.Notifications');

    // signature: Notify(s app_name, u replaces_id, s app_icon, s summary, s body, as actions, a{sv} hints, i expire_timeout) → (u id)
    const notificationId = await iface.Notify(app, 0, icon, summary, body, [], hints, expire);
    logger.info(`Notification sent: "${summary}" (ID: ${notificationId})`);

    // Play sound if not explicitly disabled
    if (payload.sound !== false) {
      playSound(SOUND_FILE, parseVolume(payload.volume) ?? SOUND_VOLUME);
    }

    return notificationId;
  } catch (err) {
    logger.error('Failed to send notification:', err.message);
    throw err;
  }
}

// ---- Main: create socket + D-Bus session ----------------------------------
(async () => {
  // Display startup configuration
  logger.info('D-Bus Notification Relay Service starting...');
  logger.info('Configuration:', {
    socketPath: SOCK_PATH,
    soundEnabled: SOUND_ENABLED,
    soundFile: SOUND_FILE,
    soundTimeout: SOUND_TIMEOUT,
    soundVolume: SOUND_VOLUME,
    socketPermissions: SOCKET_PERMISSIONS.toString(8),
    logLevel: LOG_LEVEL
  });

  // Ensure single instance: remove stale socket
  try {
    if (fs.existsSync(SOCK_PATH)) {
      fs.unlinkSync(SOCK_PATH);
      logger.debug('Removed stale socket');
    }
  } catch (err) {
    logger.error('Failed to remove stale socket:', err.message);
    process.exit(1);
  }

  // Initialize D-Bus connection
  let bus;
  try {
    bus = sessionBus();
    bus.on('error', (err) => logger.error('D-Bus error:', err.message));
    logger.debug('D-Bus session bus connected');
  } catch (err) {
    logger.error('Failed to connect to D-Bus session bus:', err.message);
    logger.error('Ensure DBUS_SESSION_BUS_ADDRESS is set correctly');
    process.exit(1);
  }

  // Create Unix socket server
  const server = net.createServer(async (socket) => {
    const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.debug(`Client connected: ${clientInfo}`);

    const chunks = [];
    let hasError = false;

    socket.on('data', (data) => {
      chunks.push(data);
      // Prevent memory exhaustion from large payloads
      const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (totalSize > 1024 * 1024) { // 1MB limit
        logger.warn(`Client ${clientInfo} sent payload too large (>${totalSize} bytes)`);
        hasError = true;
        socket.end();
      }
    });

    socket.on('end', async () => {
      if (hasError) return;

      try {
        const payload = parsePayload(Buffer.concat(chunks));

        if (!payload) {
          throw new Error('Empty or invalid payload');
        }

        if (!payload.summary || payload.summary.trim() === '') {
          throw new Error('Missing required field: summary');
        }

        await notify(bus, payload);
      } catch (err) {
        logger.error(`Notification error from ${clientInfo}:`, err.message);
      } finally {
        socket.end();
      }
    });

    socket.on('error', (err) => {
      logger.error(`Socket error from ${clientInfo}:`, err.message);
    });
  });

  // Handle server errors
  server.on('error', (err) => {
    logger.error('Server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      logger.error(`Socket ${SOCK_PATH} is already in use`);
      process.exit(1);
    }
  });

  // Start listening
  server.listen(SOCK_PATH, () => {
    try {
      fs.chmodSync(SOCK_PATH, SOCKET_PERMISSIONS);
      logger.info(`Server listening on ${SOCK_PATH} (permissions: ${SOCKET_PERMISSIONS.toString(8)})`);
    } catch (err) {
      logger.warn('Failed to set socket permissions:', err.message);
    }
  });

  // Clean up on exit
  const cleanup = () => {
    logger.info('Shutting down...');
    server.close();
    try {
      if (fs.existsSync(SOCK_PATH)) {
        fs.unlinkSync(SOCK_PATH);
        logger.debug('Socket removed');
      }
    } catch (err) {
      logger.error('Failed to remove socket:', err.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err.message);
    logger.error(err.stack);
    cleanup();
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  });
})();
