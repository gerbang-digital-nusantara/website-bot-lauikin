const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractServerGeo,
  getClientIp,
  normalizeIp
} = require('../netlify/functions/track-event')._test;

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
