const crypto = require('node:crypto');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'laukin-analytics';
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const EVENT_TYPES = new Set([
  'visitor',
  'order_intent',
  'menu_click',
  'social_click'
]);

async function getAnalyticsStore() {
  return getStore(STORE_NAME);
}

function cleanText(value, fallback, maxLength = 500) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maxLength);
}

function toWibParts(date) {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay()
  };
}

function toDayKey(date) {
  const { year, month, day } = toWibParts(date);
  return [
    String(year),
    String(month + 1).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');
}

function wibMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month, day) - WIB_OFFSET_MS);
}

function getPeriodRange(period, now = new Date()) {
  const { year, month, day, weekday } = toWibParts(now);
  let start;
  let label;

  if (period === 'week') {
    const daysSinceMonday = (weekday + 6) % 7;
    start = wibMidnightUtc(year, month, day - daysSinceMonday);
    label = 'Minggu ini';
  } else if (period === 'month') {
    start = wibMidnightUtc(year, month, 1);
    label = 'Bulan ini';
  } else {
    start = wibMidnightUtc(year, month, day);
    label = 'Hari ini';
  }

  return {
    period,
    label,
    start,
    end: now
  };
}

function getDayKeys(start, end) {
  const keys = [];
  const startParts = toWibParts(start);
  const cursor = wibMidnightUtc(
    startParts.year,
    startParts.month,
    startParts.day
  );

  while (cursor <= end) {
    keys.push(toDayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return keys;
}

async function saveAnalyticsEvent(rawEvent) {
  const type = EVENT_TYPES.has(rawEvent?.type) ? rawEvent.type : null;
  if (!type) return null;

  const now = new Date();
  const event = {
    id: crypto.randomUUID(),
    type,
    visitorId: cleanText(rawEvent.visitorId, '', 100),
    source: cleanText(rawEvent.source, 'Unknown', 100),
    device: cleanText(rawEvent.device, 'Unknown', 100),
    label: cleanText(rawEvent.label, '', 150),
    url: cleanText(rawEvent.url, '', 1000),
    timestamp: now.toISOString()
  };

  const store = await getAnalyticsStore();
  const key = `events/${toDayKey(now)}/${now.getTime()}-${event.id}.json`;
  await store.setJSON(key, event);
  return event;
}

async function getEventsForPeriod(period, now = new Date()) {
  const range = getPeriodRange(period, now);
  const store = await getAnalyticsStore();
  const dayKeys = getDayKeys(range.start, range.end);
  const prefixes = period === 'month'
    ? [`events/${dayKeys[0].slice(0, 7)}-`]
    : dayKeys.map((dayKey) => `events/${dayKey}/`);
  const events = [];

  for (const prefix of prefixes) {
    for await (const result of store.list({
      prefix,
      paginate: true
    })) {
      const entries = await Promise.all(
        result.blobs.map((blob) => store.get(blob.key, {
          type: 'json',
          consistency: 'strong'
        }))
      );

      for (const entry of entries) {
        if (!entry?.timestamp) continue;
        const timestamp = new Date(entry.timestamp);
        if (timestamp >= range.start && timestamp <= range.end) {
          events.push(entry);
        }
      }
    }
  }

  return { events, range };
}

module.exports = {
  getEventsForPeriod,
  getPeriodRange,
  saveAnalyticsEvent,
  toDayKey
};
