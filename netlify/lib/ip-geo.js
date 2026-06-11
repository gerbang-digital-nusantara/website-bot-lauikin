const net = require('node:net');

const DEFAULT_ENDPOINT = 'https://ipwho.is/{ip}';
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;
const geoCache = new Map();

function cleanText(value, maxLength = 160) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeIp(value) {
  let ip = cleanText(value, 200).split(',')[0].trim();
  if (!ip) return '';

  if (ip.startsWith('[')) {
    const closingBracket = ip.indexOf(']');
    if (closingBracket > 0) ip = ip.slice(1, closingBracket);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.replace(/:\d+$/, '');
  }

  const zoneIndex = ip.indexOf('%');
  if (zoneIndex > 0) ip = ip.slice(0, zoneIndex);

  if (ip.toLowerCase().startsWith('::ffff:')) {
    const ipv4 = ip.slice(7);
    if (net.isIP(ipv4) === 4) ip = ipv4;
  }

  return net.isIP(ip) ? ip : '';
}

function isPublicIp(ipValue) {
  const ip = normalizeIp(ipValue);
  const version = net.isIP(ip);
  if (!version) return false;

  if (version === 4) {
    const [a, b, c] = ip.split('.').map(Number);

    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  const lower = ip.toLowerCase();
  return !(
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff') ||
    lower.startsWith('2001:db8:')
  );
}

function normalizeGeo(value) {
  const geo = value && typeof value === 'object' ? value : {};
  const country = cleanText(
    geo.countryCode || geo.country_code || geo.country,
    4
  ).toUpperCase();

  return {
    country: country === 'XX' || country === 'T1' ? '' : country,
    city: cleanText(geo.city, 120),
    region: cleanText(geo.region || geo.regionName || geo.region_name, 80),
    latitude: cleanText(geo.latitude ?? geo.lat, 24),
    longitude: cleanText(geo.longitude ?? geo.lon, 24),
    ip: normalizeIp(geo.ip || geo.query)
  };
}

function mergeGeo(primary, fallback) {
  const preferred = normalizeGeo(primary);
  const secondary = normalizeGeo(fallback);

  return {
    country: preferred.country || secondary.country,
    city: preferred.city || secondary.city,
    region: preferred.region || secondary.region,
    latitude: preferred.latitude || secondary.latitude,
    longitude: preferred.longitude || secondary.longitude,
    ip: preferred.ip || secondary.ip
  };
}

function geoLookupEnabled() {
  return !['0', 'false', 'off', 'no'].includes(
    String(process.env.IP_GEOLOOKUP_ENABLED || 'true').trim().toLowerCase()
  );
}

function getCache(ip) {
  const cached = geoCache.get(ip);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    geoCache.delete(ip);
    return null;
  }

  return cached.value;
}

function setCache(ip, value, ttl) {
  if (geoCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = geoCache.keys().next().value;
    if (oldestKey) geoCache.delete(oldestKey);
  }

  geoCache.set(ip, {
    value,
    expiresAt: Date.now() + ttl
  });
}

function makeLookupUrl(ip) {
  const template = cleanText(process.env.IP_GEOLOOKUP_ENDPOINT || DEFAULT_ENDPOINT, 1000);
  const encodedIp = encodeURIComponent(ip);

  if (template.includes('{ip}')) {
    return template.replaceAll('{ip}', encodedIp);
  }

  return template.endsWith('/') ? template + encodedIp : `${template}/${encodedIp}`;
}

async function resolveGeo(geo, options = {}) {
  const normalized = normalizeGeo(geo);
  if (!normalized.ip || (normalized.country && normalized.city)) return normalized;
  if (!geoLookupEnabled() || !isPublicIp(normalized.ip)) return normalized;

  const cached = getCache(normalized.ip);
  if (cached) return mergeGeo(normalized, cached);

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') return normalized;

  const timeoutMs = Math.max(
    250,
    Number(options.timeoutMs || process.env.IP_GEOLOOKUP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(makeLookupUrl(normalized.ip), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LaukIn-Visitor/1.0'
      },
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (data?.success === false || data?.error === true) {
      throw new Error(cleanText(data.message || data.reason || 'lookup failed'));
    }

    const resolved = mergeGeo(normalized, normalizeGeo(data));
    const ttl = Math.max(
      60 * 1000,
      Number(process.env.IP_GEOLOOKUP_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS)
    );
    setCache(normalized.ip, resolved, ttl);
    return resolved;
  } catch (error) {
    setCache(normalized.ip, normalized, FAILURE_CACHE_TTL_MS);
    console.warn('[IP Geo Lookup]', error.message || String(error));
    return normalized;
  } finally {
    clearTimeout(timeout);
  }
}

function clearGeoCache() {
  geoCache.clear();
}

module.exports = {
  clearGeoCache,
  isPublicIp,
  normalizeGeo,
  normalizeIp,
  resolveGeo
};
