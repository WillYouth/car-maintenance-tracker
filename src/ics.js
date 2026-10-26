const crypto = require('node:crypto');
const db = require('./db');

const TOKEN_KEY = 'calendar_token';
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const newToken = () => crypto.randomBytes(24).toString('base64url');

function calendarToken() {
  let row = getSetting.get(TOKEN_KEY);
  if (!row) {
    putSetting.run(TOKEN_KEY, newToken());
    row = getSetting.get(TOKEN_KEY);
  }
  return row.value;
}

function rotateCalendarToken() {
  putSetting.run(TOKEN_KEY, newToken());
  return calendarToken();
}

function tokenMatches(given) {
  const expected = Buffer.from(calendarToken());
  const actual = Buffer.from(String(given));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// RFC 5545 text escaping
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Line folding at 75 characters (counted in characters, which matches ASCII content)
function fold(line) {
  const out = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest) {
    out.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return out.join('\r\n');
}

const compact = (iso) => iso.replace(/-/g, '');
function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return compact(d.toISOString().slice(0, 10));
}

const serviceDue = db.prepare(`
  SELECT id, name, next_service_date, next_service_km
  FROM vehicles WHERE next_service_date IS NOT NULL`);

const flaggedRides = db.prepare(`
  SELECT DISTINCT r.id, r.started_at, v.name
  FROM rides r
  JOIN vehicles v ON v.id = r.vehicle_id
  JOIN ride_snapshots s ON s.ride_id = r.id
  WHERE r.started_at >= datetime('now', '-90 days')
    AND (s.engine_temp_status = 'high' OR s.warning_lights <> '[]')`);

function buildIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const events = [];

  for (const v of serviceDue.all()) {
    events.push({
      uid: `service-${v.id}@car-maintenance-tracker`,
      date: v.next_service_date,
      summary: `Service due: ${v.name}`,
      description: v.next_service_km ? `Due at ${v.next_service_km} km` : '',
    });
  }
  for (const r of flaggedRides.all()) {
    events.push({
      uid: `ride-${r.id}@car-maintenance-tracker`,
      date: r.started_at.slice(0, 10),
      summary: `Warning: ${r.name}`,
      description: 'Warning light or high engine temperature reported',
    });
  }

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//car-maintenance-tracker//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:Car maintenance',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.date)}`,
      `DTEND;VALUE=DATE:${nextDay(e.date)}`,
      `SUMMARY:${esc(e.summary)}`,
      `DESCRIPTION:${esc(e.description)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { calendarToken, rotateCalendarToken, tokenMatches, buildIcs };
