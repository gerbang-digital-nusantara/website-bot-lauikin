const crypto = require('node:crypto');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const ALLOWED_TYPES = new Set([
  'visitor',
  'order_intent',
  'menu_click',
  'social_click'
]);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

function cleanText(value, fallback = '', maxLength = 500) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maxLength);
}

function hashValue(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 32);
}

function getClientIp(event) {
  return (
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['client-ip'] ||
    event.headers['x-forwarded-for'] ||
    ''
  ).split(',')[0].trim();
}

function extractServerGeo(requestEvent) {
  const h = requestEvent.headers;
  return {
    country: h['x-nf-geo-country'] || '',
    city: h['x-nf-geo-city'] || '',
    region: h['x-nf-geo-region'] || '',
    latitude: h['x-nf-geo-latitude'] || '',
    longitude: h['x-nf-geo-longitude'] || '',
    ip: getClientIp(requestEvent)
  };
}

function normalizeEvent(raw, requestEvent) {
  const source = raw && typeof raw === 'object'
    ? (raw.analytics && typeof raw.analytics === 'object' ? raw.analytics : raw)
    : {};

  const rawType = source.type === 'menu_view' ? 'menu_click' : source.type;
  const type = ALLOWED_TYPES.has(rawType) ? rawType : '';
  if (!type) {
    return null;
  }

  const eventId = cleanText(source.eventId || source.id, '', 180)
    || `${type}:${Date.now()}:${crypto.randomUUID()}`;

  const clientIp = getClientIp(requestEvent);

  return {
    eventId,
    type,
    label: cleanText(source.label, '', 180),
    visitorId: cleanText(source.visitorId, '', 180),
    sessionId: cleanText(source.sessionId, '', 180),
    source: cleanText(source.source, 'Unknown', 120),
    sourceDetail: cleanText(source.sourceDetail, '', 400),
    device: cleanText(source.device, 'Unknown', 120),
    url: cleanText(source.url, '', 1200),
    pageTitle: cleanText(source.pageTitle, '', 250),
    referrer: cleanText(source.referrer, '', 1200),
    viewport: cleanText(source.viewport, '', 80),
    language: cleanText(source.language, '', 80),
    clientTimestamp: cleanText(source.timestamp, '', 80),
    clientWibTime: cleanText(source.wibTime, '', 120),
    visitorIpHash: hashValue(clientIp),
    userAgentHash: hashValue(requestEvent.headers['user-agent'] || ''),
    receivedAt: new Date().toISOString()
  };
}

async function forwardToAdmin(payload) {
  const endpoint = process.env.ADMIN_COLLECT_ENDPOINT;
  const secret = process.env.ADMIN_INGEST_SECRET;

  if (!endpoint) {
    return {
      ok: false,
      status: 500,
      data: {
        error: 'ADMIN_COLLECT_ENDPOINT belum diisi di Netlify visitor site'
      }
    };
  }

  const headers = {
    'Content-Type': 'application/json'
  };

  if (secret) {
    headers['x-ingest-secret'] = secret;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  let data = null;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = {
      raw: text
    };
  }

  return {
    ok: response.ok && Boolean(data?.ok),
    status: response.status,
    data
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, {
      ok: false,
      error: 'Method not allowed'
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, {
      ok: false,
      error: 'Body bukan JSON valid'
    });
  }

  const analyticsEvent = normalizeEvent(body, event);
  if (!analyticsEvent) {
    return jsonResponse(400, {
      ok: false,
      error: 'Event type tidak valid'
    });
  }

  try {
    const adminResult = await forwardToAdmin({
      sourceProject: 'laukin-links-visitor',
      event: analyticsEvent,
      _serverGeo: extractServerGeo(event)
    });

    if (!adminResult.ok) {
      console.error('[Admin Collect Error]', adminResult);
      return jsonResponse(adminResult.status || 502, {
        ok: false,
        error: 'Gagal kirim data ke web admin',
        admin_status: adminResult.status,
        admin_response: adminResult.data
      });
    }

    return jsonResponse(200, {
      ok: true,
      forwarded: true,
      counted: Boolean(adminResult.data?.counted),
      duplicate: Boolean(adminResult.data?.duplicate)
    });
  } catch (error) {
    console.error('[Track Event Error]', error);
    return jsonResponse(500, {
      ok: false,
      error: 'Server error saat kirim ke admin'
    });
  }
};
