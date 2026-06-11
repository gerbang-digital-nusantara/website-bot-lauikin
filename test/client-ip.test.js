const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractServerGeo,
  getClientIp,
  normalizeIp
} = require('../netlify/functions/track-event')._test;
const {
  clearGeoCache,
  resolveGeo
} = require('../netlify/lib/ip-geo');

test('Cloudflare client IP wins over proxy addresses', () => {
  const ip = getClientIp({
    headers: {
      'cf-connecting-ip': '1.1.1.1',
      'x-real-ip': '172.18.0.1',
      'x-forwarded-for': '172.18.0.1'
    }
  });

  assert.equal(ip, '1.1.1.1');
});

test('reverse proxy real IP wins over forwarded fallback', () => {
  const ip = getClientIp({
    headers: {
      'x-real-ip': '8.8.8.8',
      'x-forwarded-for': '172.18.0.1'
    }
  });

  assert.equal(ip, '8.8.8.8');
});

test('visitor geo extraction reads proxy geo headers', () => {
  const geo = extractServerGeo({
    headers: {
      'x-real-ip': '8.8.4.4',
      'x-geo-country': 'ID',
      'x-geo-city': 'Kota%20Bogor',
      'x-geo-region': 'Jawa%20Barat'
    }
  });

  assert.equal(geo.ip, '8.8.4.4');
  assert.equal(geo.country, 'ID');
  assert.equal(geo.city, 'Kota Bogor');
  assert.equal(geo.region, 'Jawa Barat');
});

test('normalizes IPv4-mapped IPv6 addresses', () => {
  assert.equal(normalizeIp('::ffff:8.8.8.8'), '8.8.8.8');
});

test('geo fallback fills country and city before forwarding', async () => {
  clearGeoCache();
  const originalEndpoint = process.env.IP_GEOLOOKUP_ENDPOINT;
  process.env.IP_GEOLOOKUP_ENDPOINT = 'https://geo.example.test/{ip}';

  try {
    const geo = await resolveGeo(
      { ip: '8.8.8.8' },
      {
        fetchImpl: async (url) => {
          assert.equal(url, 'https://geo.example.test/8.8.8.8');
          return {
            ok: true,
            async json() {
              return {
                success: true,
                country_code: 'ID',
                city: 'Bandung',
                region: 'Jawa Barat'
              };
            }
          };
        }
      }
    );

    assert.deepEqual(geo, {
      country: 'ID',
      city: 'Bandung',
      region: 'Jawa Barat',
      latitude: '',
      longitude: '',
      ip: '8.8.8.8'
    });
  } finally {
    if (originalEndpoint === undefined) delete process.env.IP_GEOLOOKUP_ENDPOINT;
    else process.env.IP_GEOLOOKUP_ENDPOINT = originalEndpoint;
    clearGeoCache();
  }
});

test('track handler forwards resolved geo to the existing admin endpoint', async () => {
  clearGeoCache();
  const originalFetch = global.fetch;
  const originalAdminEndpoint = process.env.ADMIN_COLLECT_ENDPOINT;
  const originalSecret = process.env.ADMIN_INGEST_SECRET;
  const originalGeoEndpoint = process.env.IP_GEOLOOKUP_ENDPOINT;
  let forwardedBody = null;

  process.env.ADMIN_COLLECT_ENDPOINT = 'https://admin.example.test/collect-event';
  process.env.ADMIN_INGEST_SECRET = 'test-secret';
  process.env.IP_GEOLOOKUP_ENDPOINT = 'https://geo.example.test/{ip}';

  global.fetch = async (url, options = {}) => {
    if (String(url).startsWith('https://geo.example.test/')) {
      return {
        ok: true,
        async json() {
          return {
            success: true,
            country_code: 'ID',
            city: 'Jakarta',
            region: 'DKI Jakarta'
          };
        }
      };
    }

    assert.equal(url, 'https://admin.example.test/collect-event');
    forwardedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, counted: true });
      }
    };
  };

  try {
    const { handler } = require('../netlify/functions/track-event');
    const response = await handler({
      httpMethod: 'POST',
      headers: {
        'x-real-ip': '8.8.8.8',
        'user-agent': 'test-agent'
      },
      body: JSON.stringify({
        analytics: {
          eventId: 'geo-forward-test',
          type: 'visitor',
          visitorId: 'visitor-test',
          sessionId: 'session-test',
          source: 'Direct',
          device: 'Test'
        }
      })
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(forwardedBody._serverGeo, {
      country: 'ID',
      city: 'Jakarta',
      region: 'DKI Jakarta',
      latitude: '',
      longitude: '',
      ip: '8.8.8.8'
    });
  } finally {
    global.fetch = originalFetch;

    if (originalAdminEndpoint === undefined) delete process.env.ADMIN_COLLECT_ENDPOINT;
    else process.env.ADMIN_COLLECT_ENDPOINT = originalAdminEndpoint;

    if (originalSecret === undefined) delete process.env.ADMIN_INGEST_SECRET;
    else process.env.ADMIN_INGEST_SECRET = originalSecret;

    if (originalGeoEndpoint === undefined) delete process.env.IP_GEOLOOKUP_ENDPOINT;
    else process.env.IP_GEOLOOKUP_ENDPOINT = originalGeoEndpoint;
    clearGeoCache();
  }
});
