const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const gemini = require('./gemini');
const { rotateCalendarToken, calendarToken } = require('./ics');
const { alertWarning } = require('./notify');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PHOTO_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const SERVICE_RE = /\b(oil|brakes?|service|servicing|tune[\s-]?up)\b/i;
const SERVICE_CATEGORIES = new Set(['oil_change', 'brakes']);

const today = () => new Date().toISOString().slice(0, 10);
function addMonths(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
};
// Returns null for empty input, undefined for invalid input, otherwise the integer.
const toInt = (v, min, max) => {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

// Check magic bytes instead of trusting the client-supplied MIME type.
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === '\x89PNG') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function storeImage(buf, mime) {
  const name = `${crypto.randomUUID()}.${EXT[mime]}`;
  await fs.writeFile(path.join(config.uploadDir, name), buf);
  return name;
}

// ---------- prepared statements (compiled once, reused on every request) ----------
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ? AND active = 1'),
  vehicle: db.prepare('SELECT * FROM vehicles WHERE id = ?'),
  openRide: db.prepare("SELECT id FROM rides WHERE driver_id = ? AND vehicle_id = ? AND status = 'open'"),
  insertRide: db.prepare('INSERT INTO rides (vehicle_id, driver_id) VALUES (?, ?)'),
  closeRide: db.prepare("UPDATE rides SET status = 'closed', ended_at = datetime('now') WHERE id = ? AND status = 'open'"),
  rideOwner: db.prepare('SELECT driver_id FROM rides WHERE id = ?'),
  upsertSnapshot: db.prepare(`
    INSERT INTO ride_snapshots (ride_id, phase, mileage, fuel_percentage, engine_temp_status, warning_lights, photo_file, source)
    VALUES (@ride_id, @phase, @mileage, @fuel_percentage, @engine_temp_status, @warning_lights, @photo_file, @source)
    ON CONFLICT (ride_id, phase) DO UPDATE SET
      mileage = excluded.mileage,
      fuel_percentage = excluded.fuel_percentage,
      engine_temp_status = excluded.engine_temp_status,
      warning_lights = excluded.warning_lights,
      photo_file = COALESCE(excluded.photo_file, ride_snapshots.photo_file),
      source = excluded.source`),
  recalcDiff: db.prepare(`
    UPDATE rides SET mileage_difference = (
      SELECT a.mileage - b.mileage
      FROM ride_snapshots a JOIN ride_snapshots b ON b.ride_id = a.ride_id AND b.phase = 'before'
      WHERE a.ride_id = rides.id AND a.phase = 'after' AND a.mileage IS NOT NULL AND b.mileage IS NOT NULL)
    WHERE id = ?`),
  syncOdometer: db.prepare(`
    UPDATE vehicles SET odometer_km = (
      SELECT s.mileage FROM ride_snapshots s WHERE s.ride_id = @ride AND s.phase = 'after')
    WHERE id = (SELECT vehicle_id FROM rides WHERE id = @ride)
      AND (SELECT mileage FROM ride_snapshots WHERE ride_id = @ride AND phase = 'after') IS NOT NULL`),
  insertInvoice: db.prepare(`
    INSERT INTO maintenance (vehicle_id, driver_id, service_date, odometer_km, total_cost_cents, currency, items, invoice_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  bumpOdometer: db.prepare('UPDATE vehicles SET odometer_km = MAX(odometer_km, ?) WHERE id = ?'),
  setNextService: db.prepare('UPDATE vehicles SET next_service_km = ?, next_service_date = ? WHERE id = ?'),
};

// ---------- ride helpers ----------
const RIDE_SELECT = `
  SELECT r.id, r.vehicle_id, v.name AS vehicle, u.name AS driver, r.status, r.started_at, r.ended_at,
         r.mileage_difference,
         b.mileage AS b_mileage, b.fuel_percentage AS b_fuel, b.engine_temp_status AS b_temp,
         b.warning_lights AS b_warnings, b.photo_file AS b_photo, b.source AS b_source,
         a.mileage AS a_mileage, a.fuel_percentage AS a_fuel, a.engine_temp_status AS a_temp,
         a.warning_lights AS a_warnings, a.photo_file AS a_photo, a.source AS a_source
  FROM rides r
  JOIN vehicles v ON v.id = r.vehicle_id
  JOIN users u ON u.id = r.driver_id
  LEFT JOIN ride_snapshots b ON b.ride_id = r.id AND b.phase = 'before'
  LEFT JOIN ride_snapshots a ON a.ride_id = r.id AND a.phase = 'after'
  WHERE (@vehicleId IS NULL OR r.vehicle_id = @vehicleId)
    AND (@driverId IS NULL OR r.driver_id = @driverId)
    AND (@rideId IS NULL OR r.id = @rideId)
  ORDER BY r.started_at DESC, r.id DESC
  LIMIT @limit OFFSET @offset`;
const rideSelect = db.prepare(RIDE_SELECT);

function shapeRide(r) {
  const snap = (p) => (r[`${p}_source`] == null ? null : {
    mileage: r[`${p}_mileage`],
    fuel_percentage: r[`${p}_fuel`],
    engine_temp_status: r[`${p}_temp`],
    warning_lights: JSON.parse(r[`${p}_warnings`]),
    photo: r[`${p}_photo`] ? `/api/photos/${r[`${p}_photo`]}` : null,
    source: r[`${p}_source`],
  });
  const before = snap('b');
  const after = snap('a');
  const d = r.mileage_difference;
  const needsReview = [before, after].some((s) => s && s.mileage == null)
    || (d != null && (d < 0 || d > config.maxKmPerRide));
  return {
    id: r.id,
    vehicle_id: r.vehicle_id,
    vehicle: r.vehicle,
    driver: r.driver,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at,
    mileage_difference: d,
    needs_review: needsReview,
    before,
    after,
  };
}

const listRides = (filters) => rideSelect.all({ vehicleId: null, driverId: null, rideId: null, ...filters }).map(shapeRide);
const rideView = (id) => listRides({ rideId: id, limit: 1, offset: 0 })[0];

// Keep the derived mileage difference and vehicle odometer in sync after any snapshot change.
function syncRide(rideId) {
  q.recalcDiff.run(rideId);
  q.syncOdometer.run({ ride: rideId });
}

// ---------- auth ----------
router.post('/auth/login', wrap(async (req, res) => {
  if (!auth.loginAllowed(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const email = String(req.body?.email ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = q.userByEmail.get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  auth.startSession(res, user.id);
  res.json({ id: user.id, name: user.name, role: user.role });
}));

router.post('/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

router.get('/auth/me', auth.requireAuth, (req, res) => res.json(req.user));

// ---------- vehicles & photos ----------
router.get('/vehicles', auth.requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT v.id, v.name, v.plate, v.odometer_km, v.next_service_km, v.next_service_date,
      (SELECT r.id FROM rides r WHERE r.vehicle_id = v.id AND r.driver_id = ? AND r.status = 'open') AS open_ride_id
    FROM vehicles v ORDER BY v.name`).all(req.user.id));
});

router.post('/admin/vehicles', auth.requireAdmin, (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  const plate = String(req.body?.plate ?? '').trim().toUpperCase().slice(0, 15) || null;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const info = db.prepare('INSERT INTO vehicles (name, plate) VALUES (?, ?)').run(name, plate);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// Manual override of the service schedule ("ruleset") and odometer.
router.patch('/admin/vehicles/:id', auth.requireAdmin, (req, res) => {
  const vehicle = q.vehicle.get(Number(req.params.id));
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  const odometer = toInt(req.body?.odometer_km, 0, 9_999_999);
  const nextKm = toInt(req.body?.next_service_km, 0, 9_999_999);
  const nextDate = req.body?.next_service_date ? String(req.body.next_service_date) : null;
  if (odometer === undefined || nextKm === undefined || (nextDate && !/^\d{4}-\d{2}-\d{2}$/.test(nextDate))) {
    return res.status(400).json({ error: 'Invalid values' });
  }
  db.prepare(`UPDATE vehicles SET odometer_km = COALESCE(?, odometer_km), next_service_km = ?, next_service_date = ? WHERE id = ?`)
    .run(odometer, nextKm, nextDate, vehicle.id);
  res.json({ ok: true });
});

router.get('/admin/overview', auth.requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT v.id, v.name, v.plate, v.odometer_km, v.next_service_km, v.next_service_date,
      (SELECT COUNT(*) FROM rides r WHERE r.vehicle_id = v.id AND r.started_at >= datetime('now', '-30 days')) AS rides_30d,
      (SELECT COALESCE(SUM(r.mileage_difference), 0) FROM rides r
         WHERE r.vehicle_id = v.id AND r.started_at >= datetime('now', '-30 days')) AS km_30d
    FROM vehicles v ORDER BY v.name`).all());
});

router.get('/photos/:name', auth.requireAuth, (req, res) => {
  if (!PHOTO_NAME.test(req.params.name)) return res.status(404).end();
  res.sendFile(
    path.join(config.uploadDir, req.params.name),
    { headers: { 'Cache-Control': 'private, max-age=86400' } },
    (err) => { if (err && !res.headersSent) res.status(404).end(); },
  );
});

// ---------- rides (Group A: Before / After) ----------
router.post('/rides/scan', auth.requireAuth, upload.single('image'), wrap(async (req, res) => {
  const phase = req.body.phase;
  const vehicleId = Number(req.body.vehicle_id);
  const mime = req.file && sniffImage(req.file.buffer);
  if (!['before', 'after'].includes(phase) || !mime) {
    return res.status(400).json({ error: 'A phase and a JPEG, PNG or WebP photo are required' });
  }
  const vehicle = q.vehicle.get(vehicleId);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  const open = q.openRide.get(req.user.id, vehicleId);
  if (phase === 'after' && !open) {
    return res.status(409).json({ error: 'No open ride. Take the Before-ride photo first.' });
  }

  const photo = await storeImage(req.file.buffer, mime);
  let reading;
  let aiError = false;
  try {
    reading = await gemini.readDashboard(req.file.buffer, mime);
  } catch (err) {
    // Degrade gracefully: keep the photo and let the driver type the values.
    console.error('Dashboard OCR failed:', err.message);
    aiError = true;
    reading = { mileage: null, fuel_percentage: null, engine_temp_status: 'normal', warning_lights: [] };
  }

  const rideId = open?.id ?? Number(q.insertRide.run(vehicleId, req.user.id).lastInsertRowid);
  q.upsertSnapshot.run({
    ride_id: rideId,
    phase,
    mileage: reading.mileage,
    fuel_percentage: reading.fuel_percentage,
    engine_temp_status: reading.engine_temp_status,
    warning_lights: JSON.stringify(reading.warning_lights),
    photo_file: photo,
    source: aiError ? 'manual' : 'ai',
  });
  if (phase === 'after') q.closeRide.run(rideId);
  syncRide(rideId);

  const flags = [];
  if (reading.engine_temp_status === 'high') flags.push('engine temperature high');
  flags.push(...reading.warning_lights.map((w) => `warning light: ${w}`));
  if (flags.length) {
    alertWarning({ vehicle: vehicle.name, driver: req.user.name, phase, flags })
      .catch((err) => console.error('Alert failed:', err.message));
  }

  res.json({ ...rideView(rideId), ai_error: aiError });
}));

// Driver verification screen: confirm or override the AI numbers.
router.patch('/rides/:id', auth.requireAuth, (req, res) => {
  const rideId = Number(req.params.id);
  const owner = q.rideOwner.get(rideId);
  if (!owner) return res.status(404).json({ error: 'Ride not found' });
  if (owner.driver_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your ride' });

  const phase = req.body?.phase;
  const mileage = toInt(req.body?.mileage, 0, 9_999_999);
  const fuel = toInt(req.body?.fuel_percentage, 0, 100);
  if (!['before', 'after'].includes(phase)) return res.status(400).json({ error: 'Invalid phase' });
  if (mileage === undefined || fuel === undefined) return res.status(400).json({ error: 'Numbers are not valid' });

  const warnings = (Array.isArray(req.body?.warning_lights) ? req.body.warning_lights : [])
    .map((s) => String(s).trim().toLowerCase().slice(0, 40))
    .filter(Boolean)
    .slice(0, 20);

  q.upsertSnapshot.run({
    ride_id: rideId,
    phase,
    mileage,
    fuel_percentage: fuel,
    engine_temp_status: req.body?.engine_temp_status === 'high' ? 'high' : 'normal',
    warning_lights: JSON.stringify(warnings),
    photo_file: null,
    source: 'manual',
  });
  syncRide(rideId);
  res.json(rideView(rideId));
});

router.get('/rides', auth.requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';
  res.json(listRides({
    vehicleId: req.query.vehicle_id ? Number(req.query.vehicle_id) : null,
    driverId: isAdmin ? null : req.user.id,
    limit: clamp(req.query.limit, 1, 100, 20),
    offset: clamp(req.query.offset, 0, 1e9, 0),
  }));
});

// ---------- maintenance invoices (Group A upload, Group B read) ----------
router.post('/maintenance', auth.requireAuth, upload.single('invoice'), wrap(async (req, res) => {
  const vehicleId = Number(req.body.vehicle_id);
  const mime = req.file && sniffImage(req.file.buffer);
  if (!mime) return res.status(400).json({ error: 'An invoice photo (JPEG, PNG or WebP) is required' });
  const vehicle = q.vehicle.get(vehicleId);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  const manualKm = toInt(req.body.odometer_km, 0, 9_999_999);
  if (manualKm === undefined) return res.status(400).json({ error: 'Odometer is not valid' });

  const file = await storeImage(req.file.buffer, mime);
  let invoice;
  let aiError = false;
  try {
    invoice = await gemini.readInvoice(req.file.buffer, mime);
  } catch (err) {
    console.error('Invoice OCR failed:', err.message);
    aiError = true;
    invoice = { service_date: null, odometer_km: null, total_cost: null, currency: null, items: [] };
  }

  const serviceDate = invoice.service_date ?? today();
  const km = manualKm ?? invoice.odometer_km;
  const isService = invoice.items.some((i) => SERVICE_RE.test(i.description) || SERVICE_CATEGORIES.has(i.category));
  const cents = invoice.total_cost == null ? null : Math.round(invoice.total_cost * 100);

  db.transaction(() => {
    q.insertInvoice.run(
      vehicleId, req.user.id, serviceDate, km, cents, invoice.currency,
      JSON.stringify(invoice.items), file,
    );
    if (km != null) q.bumpOdometer.run(km, vehicleId);
    if (isService) {
      const base = km ?? vehicle.odometer_km;
      q.setNextService.run(
        base + config.serviceIntervalKm,
        addMonths(serviceDate, config.serviceIntervalMonths),
        vehicleId,
      );
    }
  })();

  const updated = db.prepare('SELECT next_service_km, next_service_date FROM vehicles WHERE id = ?').get(vehicleId);
  res.status(201).json({
    service_date: serviceDate,
    odometer_km: km,
    total_cost: invoice.total_cost,
    currency: invoice.currency,
    items: invoice.items,
    is_service: isService,
    next_service_km: isService ? updated.next_service_km : null,
    next_service_date: isService ? updated.next_service_date : null,
    ai_error: aiError,
  });
}));

router.get('/maintenance', auth.requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.vehicle_id, v.name AS vehicle, u.name AS driver, m.service_date, m.odometer_km,
           m.total_cost_cents, m.currency, m.items, m.invoice_file, m.created_at
    FROM maintenance m
    JOIN vehicles v ON v.id = m.vehicle_id
    JOIN users u ON u.id = m.driver_id
    WHERE (@vehicleId IS NULL OR m.vehicle_id = @vehicleId)
      AND (@driverId IS NULL OR m.driver_id = @driverId)
    ORDER BY m.service_date DESC, m.id DESC
    LIMIT 100`).all({
    vehicleId: req.query.vehicle_id ? Number(req.query.vehicle_id) : null,
    driverId: req.user.role === 'admin' ? null : req.user.id,
  });
  res.json(rows.map(({ invoice_file, items, ...row }) => ({
    ...row,
    items: JSON.parse(items),
    invoice: `/api/photos/${invoice_file}`,
  })));
});

// ---------- admin: drivers ----------
router.get('/admin/users', auth.requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT id, email, name, role FROM users WHERE active = 1 ORDER BY role, name").all());
});

router.post('/admin/users', auth.requireAdmin, wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  const password = String(req.body?.password ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || password.length < 8) {
    return res.status(400).json({ error: 'Valid email, name and an 8+ character password are required' });
  }
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'driver')")
    .run(email, name, hash);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
}));

// Soft delete: the driver can no longer sign in, but their rides and invoices remain.
router.delete('/admin/users/:id', auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't remove your own account" });
  db.transaction(() => {
    db.prepare("UPDATE users SET active = 0 WHERE id = ? AND role = 'driver'").run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  })();
  res.json({ ok: true });
});

// ---------- admin: calendar feed ----------
router.get('/admin/calendar', auth.requireAdmin, (req, res) => {
  res.json({ url: `${config.publicUrl}/calendar/${calendarToken()}.ics` });
});

router.post('/admin/calendar/rotate', auth.requireAdmin, (req, res) => {
  res.json({ url: `${config.publicUrl}/calendar/${rotateCalendarToken()}.ics` });
});

module.exports = router;
