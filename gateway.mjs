#!/usr/bin/env node
// Local gateway between Nx and the cache Worker. Cloudflare's edge refuses a
// request body over 100 MB with 413 before the Worker runs, and Nx fails the
// task on a 413. So a PUT over the threshold goes through an upload slot
// straight to R2; every other request is proxied unchanged.
//
// Env: NX_CACHE_GATEWAY_UPSTREAM (Worker origin), NX_CACHE_GATEWAY_THRESHOLD
// (bytes), NX_CACHE_GATEWAY_PORT_FILE (receives the bound port),
// NX_CACHE_GATEWAY_CONTROL_TIMEOUT_MS (optional, default 30000). It logs to
// stderr; the action's post step copies the "not cached" lines into the job.
//
// Toward Nx a failure of the gateway's own is a 404 (a miss) for a read and a
// 403 for a write, both of which Nx lets pass, or a 409 for "already cached".
// Never 413, 429, 5xx or a reset: Nx retries or fails on those and then fails
// the CI task. Node 20 built-ins only.
import { renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const env = process.env;
const upstream = new URL(env.NX_CACHE_GATEWAY_UPSTREAM ?? '');
const threshold = Number(env.NX_CACHE_GATEWAY_THRESHOLD ?? 99614720);
const controlTimeoutMs = Number(
  env.NX_CACHE_GATEWAY_CONTROL_TIMEOUT_MS ?? 30000,
);
const portFile = env.NX_CACHE_GATEWAY_PORT_FILE;

const HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CACHE_PUT_RE = /^\/v1\/cache\/([^/?]*)(?:\?.*)?$/;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const clientFor = (url) => (url.protocol === 'https:' ? https : http);

const forwardable = (headers) => {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      out[name] = value;
    }
  }
  return out;
};

/** One line in the gateway log; post.mjs copies the "not cached" ones into the job. */
const warn = (line) => process.stderr.write(`${line}\n`);

/** A short reason for the log: a system error code, "timed out", or the message. */
const reasonOf = (error) => {
  if (error?.name === 'TimeoutError') return 'timed out';
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
};

/**
 * Resolves once the whole request body has been read. Answering before that
 * would close a connection Nx is still writing to, and Nx retries a reset.
 */
const drained = (req) =>
  new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) return resolve();
    req.unpipe();
    req.on('end', resolve);
    req.on('error', resolve);
    req.on('close', resolve);
    req.resume();
  });

const answer = async (req, res, status) => {
  await drained(req);
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-length': '0' });
  res.end();
};

/**
 * The answer to a failure of the gateway's own. Nx reads a GET 404 as a miss
 * and builds the task; it fails the task on a GET 401, 403, 5xx or reset. It
 * ignores a 403 to a write.
 */
const failureStatus = (method) =>
  method === 'GET' || method === 'HEAD' ? 404 : 403;

/** Destroys `out` when Nx goes away before its response is finished. */
const dropWithClient = (res, out) =>
  res.on('close', () => {
    if (!res.writableFinished) out.destroy(new Error('client went away'));
  });

/** Proxies one request to the Worker, streaming both bodies. */
const proxy = (req, res) => {
  const target = new URL(req.url ?? '/', upstream);
  const out = clientFor(target).request(target, {
    method: req.method,
    headers: forwardable(req.headers),
  });
  dropWithClient(res, out);
  // The connect, and the wait from the end of the request body to the
  // response headers, each get the control timeout. A response body that is
  // flowing gets none, however long it takes.
  let timer;
  let sent = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => out.destroy(new Error('upstream timeout')),
      controlTimeoutMs,
    );
  };
  arm();
  out.on('socket', (socket) => {
    const connected = () => {
      if (!sent) clearTimeout(timer);
    };
    if (socket.connecting) socket.once('connect', connected);
    else connected();
  });
  out.on('finish', () => {
    sent = true;
    arm();
  });
  out.on('response', (upstreamRes) => {
    clearTimeout(timer);
    res.writeHead(
      upstreamRes.statusCode ?? 502,
      forwardable(upstreamRes.headers),
    );
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => res.destroy());
  });
  out.on('error', (error) => {
    clearTimeout(timer);
    if (res.headersSent || res.destroyed) return void res.destroy();
    process.stderr.write(
      `nx-cache gateway: ${req.method} ${target.pathname} failed: ${reasonOf(error)}\n`,
    );
    void answer(req, res, failureStatus(req.method));
  });
  req.pipe(out);
};

/** A small JSON POST to the Worker with Nx's Authorization, under the control timeout. */
const control = (path, authorization, body) =>
  fetch(new URL(path, upstream), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(controlTimeoutMs),
  });

/** Streams the request body to a presigned URL with exactly its headers; resolves to R2's status. */
const upload = (req, res, url, headers) =>
  new Promise((resolve, reject) => {
    if (req.destroyed || res.destroyed) {
      return reject(new Error('client went away'));
    }
    const target = new URL(url);
    const out = clientFor(target).request(target, { method: 'PUT', headers });
    dropWithClient(res, out);
    out.on('response', (r2Res) => {
      r2Res.resume();
      resolve(r2Res.statusCode ?? 0);
    });
    out.on('error', reject);
    req.pipe(out);
  });

const isSlot = (v) =>
  typeof v === 'object' &&
  v !== null &&
  typeof v.url === 'string' &&
  /^https?:\/\//.test(v.url) &&
  typeof v.headers === 'object' &&
  v.headers !== null &&
  Object.values(v.headers).every((h) => typeof h === 'string');

/** A PUT over the threshold: slot, body to R2, complete. */
const largePut = async (req, res, hash, size) => {
  const refuse = async (reason) => {
    warn(`nx-cache gateway: ${hash} not cached: ${reason}`);
    await answer(req, res, 403);
  };
  if (!HASH_RE.test(hash)) return refuse('invalid hash');
  const authorization = req.headers.authorization;

  let slot;
  try {
    const slotRes = await control('/v1/uploads', authorization, { hash, size });
    if (slotRes.status === 409) {
      await slotRes.body?.cancel();
      return answer(req, res, 409);
    }
    if (slotRes.status !== 200) {
      await slotRes.body?.cancel();
      return refuse(`upload slot refused (HTTP ${slotRes.status})`);
    }
    slot = await slotRes.json();
  } catch (error) {
    return refuse(`upload slot request failed: ${reasonOf(error)}`);
  }
  if (!isSlot(slot)) return refuse('upload slot response was malformed');

  let status;
  try {
    status = await upload(req, res, slot.url, slot.headers);
  } catch (error) {
    return refuse(`upload failed: ${reasonOf(error)}`);
  }
  if (status === 412) return answer(req, res, 409);
  if (status < 200 || status > 299) {
    return refuse(`upload refused (HTTP ${status})`);
  }

  try {
    const done = await control('/v1/uploads/complete', authorization, { hash });
    await done.body?.cancel();
    if (done.status < 200 || done.status > 299) {
      return refuse(`complete failed (HTTP ${done.status})`);
    }
  } catch (error) {
    return refuse(`complete failed: ${reasonOf(error)}`);
  }
  return answer(req, res, 200);
};

const handle = (req, res) => {
  const size = Number(req.headers['content-length']);
  const match = req.method === 'PUT' ? CACHE_PUT_RE.exec(req.url ?? '') : null;
  if (match && Number.isSafeInteger(size) && size > threshold) {
    largePut(req, res, match[1], size).catch((error) => {
      warn(`nx-cache gateway: ${match[1]} not cached: ${reasonOf(error)}`);
      void answer(req, res, 403);
    });
    return;
  }
  proxy(req, res);
};

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (error) {
    // A request target `new URL` cannot parse, for one.
    process.stderr.write(
      `nx-cache gateway: ${req.method} request failed: ${reasonOf(error)}\n`,
    );
    answer(req, res, failureStatus(req.method)).catch(() => undefined);
  }
});

// One bad request must not take the gateway down: Nx would then fail every
// later task on a refused connection.
const survive = (error) =>
  process.stderr.write(
    `nx-cache gateway: unexpected error: ${reasonOf(error)}\n`,
  );
process.on('uncaughtException', survive);
process.on('unhandledRejection', survive);

// An upload of several GiB can take longer than Node's default 5 minutes.
server.requestTimeout = 0;

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  if (portFile) {
    // Written whole, then renamed, so a reader never sees a partial port.
    writeFileSync(`${portFile}.tmp`, String(port));
    renameSync(`${portFile}.tmp`, portFile);
  }
});
