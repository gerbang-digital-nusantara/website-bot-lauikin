const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { handler: trackEventHandler } = require('./netlify/functions/track-event');

const PORT = Number(process.env.PORT || 4099);
const ROOT_DIR = __dirname;
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const STATIC_EXTENSIONS = new Set(Object.keys(MIME_TYPES));
const BLOCKED_PATH_PARTS = new Set([
  '.git',
  '.github',
  'node_modules',
  '.env',
  'Dockerfile',
  'docker-compose.yml',
  'package.json',
  'package-lock.json',
  'server.js'
]);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function writeResponse(res, lambdaResponse) {
  const headers = lambdaResponse.headers || {};
  res.writeHead(lambdaResponse.statusCode || 200, headers);
  res.end(lambdaResponse.body || '');
}

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
        reject(new Error('Payload terlalu besar'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getClientIp(req) {
  return (
    req.headers['x-nf-client-connection-ip'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['true-client-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    ''
  ).toString().split(',')[0].trim();
}

function createFunctionEvent(req, body, url) {
  return {
    httpMethod: req.method,
    headers: {
      ...req.headers,
      'client-ip': getClientIp(req)
    },
    body,
    path: url.pathname,
    rawUrl: url.toString(),
    queryStringParameters: Object.fromEntries(url.searchParams.entries())
  };
}

async function handleTrackEvent(req, res, url) {
  try {
    const body = req.method === 'OPTIONS' ? '' : await getRequestBody(req);
    const lambdaResponse = await trackEventHandler(createFunctionEvent(req, body, url));
    writeResponse(res, lambdaResponse);
  } catch (error) {
    if (error.message === 'Payload terlalu besar') {
      return sendJson(res, 413, {
        ok: false,
        error: error.message
      });
    }

    console.error('[Track Event Server Error]', error);
    sendJson(res, 500, {
      ok: false,
      error: 'Server error saat memproses tracking'
    });
  }
}

function isBlockedStaticPath(relativePath) {
  const parts = relativePath.split(path.sep).filter(Boolean);

  return parts.some(part => (
    BLOCKED_PATH_PARTS.has(part) ||
    part.startsWith('.')
  ));
}

function resolveStaticPath(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const cleanPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const relativePath = cleanPath.replace(/^\/+/, '');
  const absolutePath = path.resolve(ROOT_DIR, relativePath);

  if (!absolutePath.startsWith(ROOT_DIR + path.sep) && absolutePath !== ROOT_DIR) {
    return null;
  }

  if (isBlockedStaticPath(relativePath)) {
    return null;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (!STATIC_EXTENSIONS.has(ext)) {
    return null;
  }

  return absolutePath;
}

function serveStatic(req, res, url) {
  const filePath = resolveStaticPath(url.pathname);

  if (!filePath) {
    return sendJson(res, 404, {
      ok: false,
      error: 'Not found'
    });
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      return sendJson(res, 404, {
        ok: false,
        error: 'Not found'
      });
    }

    const ext = path.extname(filePath).toLowerCase();
    const cacheControl = ext === '.html'
      ? 'no-cache'
      : 'public, max-age=604800, immutable';

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'laukin-web',
      uptime: process.uptime()
    });
  }

  if (
    url.pathname === '/.netlify/functions/track-event' ||
    url.pathname === '/api/track-event'
  ) {
    return handleTrackEvent(req, res, url);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, {
      ok: false,
      error: 'Method not allowed'
    });
  }

  return serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lauk.In web running at http://0.0.0.0:${PORT}`);
});
