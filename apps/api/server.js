'use strict';
/*
 * Ride-hailing MVP server (Amman / JOD / cash only).
 * Zero external dependencies: Node >= 22.5 (built-in node:sqlite) + Server-Sent Events.
 *
 * Env: PORT (3000), ADMIN_PASSWORD, AUTO_APPROVE=1 (skip driver approval), DB_FILE
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createNewsroom } = require('./newsroom');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const AUTO_APPROVE = process.env.AUTO_APPROVE === '1';
const ROOT_DIR = path.resolve(__dirname, '../..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT_DIR, 'ride.db');
const STATIC_ROUTES = [
  { prefix: '/shared/', root: path.join(ROOT_DIR, 'packages', 'shared', 'public') },
  { prefix: '/rider/', root: path.join(ROOT_DIR, 'apps', 'rider', 'public') },
  { prefix: '/driver/', root: path.join(ROOT_DIR, 'apps', 'driver', 'public') },
  { prefix: '/admin/', root: path.join(ROOT_DIR, 'apps', 'admin', 'public') },
];
const LANDING_DIR = path.join(ROOT_DIR, 'apps', 'web', 'public');
const LOC_FRESH_MS = 120 * 1000; // driver location considered live for 2 minutes
const REQUEST_TTL_MS = 180 * 1000; // unanswered request expires after 3 minutes
const TZ_OFFSET_MS = 3 * 3600 * 1000; // Jordan: UTC+3 (no DST)

/* ------------------------------------------------------------------ DB */
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('rider','driver')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  car TEXT, plate TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  lat REAL, lng REAL, loc_at INTEGER,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(phone, role)
);
CREATE TABLE IF NOT EXISTS rides(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL,
  pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL, pickup_name TEXT,
  drop_lat REAL NOT NULL, drop_lng REAL NOT NULL, drop_name TEXT,
  distance_km REAL NOT NULL,
  fare REAL NOT NULL,
  commission REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER, arrived_at INTEGER, started_at INTEGER, completed_at INTEGER,
  cancelled_by TEXT,
  stars INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value REAL NOT NULL);
`);

const DEFAULTS = { base_fare: 0.5, per_km: 0.3, min_fare: 1.0, commission_rate: 0.15, radius_km: 5 };
const LIMITS = {
  base_fare: [0, 20], per_km: [0, 10], min_fare: [0, 50], commission_rate: [0, 0.5], radius_km: [0.5, 50],
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
}
const getSettings = () =>
  Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
const newsroom = createNewsroom({ db });

/* ------------------------------------------------------------- helpers */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => Date.now();
const round2 = (n) => Math.round(n * 100) / 100;
const cleanStr = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' ? v : NaN);
const validPoint = (p) =>
  p && Number.isFinite(num(p.lat)) && Number.isFinite(num(p.lng)) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
function normPhone(s) {
  const d = String(s || '').replace(/[\s\-()]/g, '');
  return /^\+?\d{8,15}$/.test(d) ? d : null;
}
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, h] = stored.split(':');
  const c = crypto.scryptSync(pin, salt, 32);
  const hb = Buffer.from(h, 'hex');
  return c.length === hb.length && crypto.timingSafeEqual(c, hb);
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// very small brute-force limiter: 8 failed attempts / 10 min per key
const failures = new Map();
function blocked(key) {
  const t = now();
  const arr = (failures.get(key) || []).filter((x) => t - x < 600000);
  failures.set(key, arr);
  return arr.length >= 8;
}
function noteFailure(key) {
  const arr = failures.get(key) || [];
  arr.push(now());
  failures.set(key, arr);
}

/* ---------------------------------------------------------- realtime (SSE) */
const streams = new Map(); // key -> Set<res>
function push(key, event, data) {
  const set = streams.get(key);
  if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}
setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 25000);

/* -------------------------------------------------------------- queries */
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, phone: u.phone,
  car: u.car, plate: u.plate, approved: !!u.approved, online: !!u.online,
  rating: u.rating_count ? round2(u.rating_sum / u.rating_count) : null,
});
const ACTIVE_RIDER = "('requested','accepted','arrived','in_progress')";
const ACTIVE_DRIVER = "('accepted','arrived','in_progress')";
const riderActiveRide = (id) =>
  db.prepare(`SELECT id FROM rides WHERE rider_id=? AND status IN ${ACTIVE_RIDER} ORDER BY id DESC LIMIT 1`).get(id);
const driverActiveRide = (id) =>
  db.prepare(`SELECT id FROM rides WHERE driver_id=? AND status IN ${ACTIVE_DRIVER} ORDER BY id DESC LIMIT 1`).get(id);

function rideRow(id) {
  return db.prepare(`
    SELECT r.*, ru.name AS rider_name, ru.phone AS rider_phone,
           du.name AS driver_name, du.phone AS driver_phone, du.car, du.plate,
           du.lat AS driver_lat, du.lng AS driver_lng, du.rating_sum, du.rating_count
    FROM rides r JOIN users ru ON ru.id=r.rider_id LEFT JOIN users du ON du.id=r.driver_id
    WHERE r.id=?`).get(id);
}
function rideView(r, viewer) {
  const v = {
    id: r.id, status: r.status,
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng, name: r.pickup_name },
    drop: { lat: r.drop_lat, lng: r.drop_lng, name: r.drop_name },
    distance_km: round2(r.distance_km), fare: round2(r.fare),
    created_at: r.created_at, accepted_at: r.accepted_at, started_at: r.started_at, completed_at: r.completed_at,
    cancelled_by: r.cancelled_by, stars: r.stars,
  };
  if (r.driver_id) {
    if (viewer === 'rider' || viewer === 'admin') {
      v.driver = {
        name: r.driver_name, phone: r.driver_phone, car: r.car, plate: r.plate,
        lat: r.driver_lat, lng: r.driver_lng,
        rating: r.rating_count ? round2(r.rating_sum / r.rating_count) : null,
      };
    }
    if (viewer === 'driver' || viewer === 'admin') {
      v.rider = { name: r.rider_name, phone: r.rider_phone };
      v.commission = round2(r.commission);
    }
  }
  if (viewer === 'admin') { v.rider_name = r.rider_name; v.driver_name = r.driver_name; }
  return v;
}
function notifyRide(id) {
  const r = rideRow(id);
  if (!r) return;
  push('u:' + r.rider_id, 'ride', rideView(r, 'rider'));
  if (r.driver_id) push('u:' + r.driver_id, 'ride', rideView(r, 'driver'));
}
function quote(pickup, drop) {
  const s = getSettings();
  const km = Math.max(0.2, haversineKm(pickup, drop) * 1.3); // straight line -> approx road distance
  if (km > 150) throw new HttpError(400, 'المسافة بعيدة جداً');
  const fare = round2(Math.max(s.min_fare, s.base_fare + s.per_km * km));
  return { distance_km: round2(km), fare, eta_min: Math.max(2, Math.round((km / 25) * 60)), currency: 'JOD' };
}
function nearbyDrivers(point) {
  const s = getSettings();
  const fresh = now() - LOC_FRESH_MS;
  const rows = db.prepare(`
    SELECT * FROM users WHERE role='driver' AND approved=1 AND blocked=0 AND online=1 AND loc_at>?
      AND id NOT IN (SELECT driver_id FROM rides WHERE driver_id IS NOT NULL AND status IN ${ACTIVE_DRIVER})`).all(fresh);
  return rows
    .map((d) => ({ d, km: haversineKm(point, { lat: d.lat, lng: d.lng }) }))
    .filter((x) => x.km <= s.radius_km)
    .sort((a, b) => a.km - b.km);
}
function offerView(r, driver) {
  const v = rideView(r, 'driver');
  delete v.rider; // rider contact only after accepting
  v.pickup_distance_km = round2(haversineKm({ lat: driver.lat, lng: driver.lng }, { lat: r.pickup_lat, lng: r.pickup_lng }));
  v.driver_earning = round2(r.fare * (1 - getSettings().commission_rate));
  return v;
}

/* --------------------------------------------------------------- routes */
const routes = [];
function route(method, pattern, auth, handler) {
  routes.push({ method, auth, handler, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
}
const adminTokens = new Map(); // token -> expiry

// ---- public
route('GET', '/api/health', 'none', () => [200, { ok: true, time: now() }]);

route('POST', '/api/register', 'none', ({ body }) => {
  const role = body.role;
  if (!['rider', 'driver'].includes(role)) throw new HttpError(400, 'نوع الحساب غير صحيح');
  const name = cleanStr(body.name, 60);
  if (name.length < 2) throw new HttpError(400, 'اكتب اسمك');
  const phone = normPhone(body.phone);
  if (!phone) throw new HttpError(400, 'رقم الهاتف غير صحيح');
  const pin = String(body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'الرمز السري لازم يكون من 4 إلى 8 أرقام');
  let car = null, plate = null;
  if (role === 'driver') {
    car = cleanStr(body.car, 40); plate = cleanStr(body.plate, 15);
    if (!car || !plate) throw new HttpError(400, 'اكتب نوع السيارة ورقم اللوحة');
  }
  if (db.prepare('SELECT 1 FROM users WHERE phone=? AND role=?').get(phone, role)) {
    throw new HttpError(409, 'الرقم مسجّل من قبل، سجّل دخولك');
  }
  const token = crypto.randomBytes(24).toString('hex');
  const approved = role === 'rider' || AUTO_APPROVE ? 1 : 0;
  const r = db.prepare(
    'INSERT INTO users(role,name,phone,pin_hash,token,car,plate,approved,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(role, name, phone, hashPin(pin), token, car, plate, approved, now());
  return [201, { token, user: publicUser(getUser(Number(r.lastInsertRowid))) }];
});

route('POST', '/api/login', 'none', ({ body, ip }) => {
  const role = body.role;
  const phone = normPhone(body.phone);
  const pin = String(body.pin || '');
  const key = `${ip}|${phone}`;
  if (blocked(key)) throw new HttpError(429, 'محاولات كثيرة، جرّب بعد شوي');
  const u = ['rider', 'driver'].includes(role) && phone
    ? db.prepare('SELECT * FROM users WHERE phone=? AND role=?').get(phone, role) : null;
  if (!u || !checkPin(pin, u.pin_hash)) { noteFailure(key); throw new HttpError(401, 'الرقم أو الرمز السري غير صحيح'); }
  if (u.blocked) throw new HttpError(403, 'هذا الحساب موقوف');
  return [200, { token: u.token, user: publicUser(u) }];
});

route('POST', '/api/admin/login', 'none', ({ body, ip }) => {
  if (!ADMIN_PASSWORD) throw new HttpError(503, 'تسجيل دخول الإدارة غير مهيأ');
  const key = 'admin|' + ip;
  if (blocked(key)) throw new HttpError(429, 'محاولات كثيرة، جرّب بعد شوي');
  if (!safeEqual(body.password || '', ADMIN_PASSWORD)) { noteFailure(key); throw new HttpError(401, 'كلمة السر غير صحيحة'); }
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, now() + 12 * 3600 * 1000);
  return [200, { token }];
});

// ---- common (rider or driver)
route('GET', '/api/me', 'user', ({ user }) => {
  const active = user.role === 'rider' ? riderActiveRide(user.id) : driverActiveRide(user.id);
  const s = getSettings();
  return [200, {
    user: publicUser(user),
    ride: active ? rideView(rideRow(active.id), user.role) : null,
    pricing: { base_fare: s.base_fare, per_km: s.per_km, min_fare: s.min_fare, currency: 'JOD' },
  }];
});

route('GET', '/api/rides/history', 'user', ({ user }) => {
  const col = user.role === 'rider' ? 'rider_id' : 'driver_id';
  const rows = db.prepare(`SELECT id FROM rides WHERE ${col}=? AND status IN ('completed','cancelled','expired') ORDER BY id DESC LIMIT 30`).all(user.id);
  return [200, { rides: rows.map((x) => rideView(rideRow(x.id), user.role)) }];
});

// ---- rider
route('POST', '/api/rides/estimate', 'rider', ({ body }) => {
  if (!validPoint(body.pickup) || !validPoint(body.drop)) throw new HttpError(400, 'حدّد نقطة الانطلاق والوجهة');
  const q = quote(body.pickup, body.drop);
  q.drivers_nearby = nearbyDrivers(body.pickup).length;
  return [200, q];
});

route('POST', '/api/rides', 'rider', ({ user, body }) => {
  if (!validPoint(body.pickup) || !validPoint(body.drop)) throw new HttpError(400, 'حدّد نقطة الانطلاق والوجهة');
  if (riderActiveRide(user.id)) throw new HttpError(409, 'عندك رحلة شغّالة');
  const q = quote(body.pickup, body.drop);
  const r = db.prepare(`INSERT INTO rides(rider_id,status,pickup_lat,pickup_lng,pickup_name,drop_lat,drop_lng,drop_name,distance_km,fare,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    user.id, 'requested', body.pickup.lat, body.pickup.lng, cleanStr(body.pickup.name, 120) || null,
    body.drop.lat, body.drop.lng, cleanStr(body.drop.name, 120) || null, q.distance_km, q.fare, now());
  const id = Number(r.lastInsertRowid);
  const row = rideRow(id);
  for (const { d } of nearbyDrivers({ lat: row.pickup_lat, lng: row.pickup_lng })) {
    push('u:' + d.id, 'offer', offerView(row, d));
  }
  return [201, { ride: rideView(row, 'rider') }];
});

route('POST', '/api/rides/:id/rate', 'rider', ({ user, params, body }) => {
  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, 'التقييم من 1 إلى 5');
  const r = db.prepare('SELECT * FROM rides WHERE id=? AND rider_id=?').get(Number(params.id), user.id);
  if (!r) throw new HttpError(404, 'الرحلة غير موجودة');
  if (r.status !== 'completed' || r.stars) throw new HttpError(409, 'ما بتقدر تقيّم هالرحلة');
  db.prepare('UPDATE rides SET stars=? WHERE id=?').run(stars, r.id);
  db.prepare('UPDATE users SET rating_sum=rating_sum+?, rating_count=rating_count+1 WHERE id=?').run(stars, r.driver_id);
  return [200, { ok: true }];
});

// ---- cancel (rider or driver)
route('POST', '/api/rides/:id/cancel', 'user', ({ user, params }) => {
  const id = Number(params.id);
  const r = db.prepare('SELECT * FROM rides WHERE id=?').get(id);
  if (!r) throw new HttpError(404, 'الرحلة غير موجودة');
  if (user.role === 'rider') {
    if (r.rider_id !== user.id) throw new HttpError(403, 'غير مسموح');
    if (!['requested', 'accepted', 'arrived'].includes(r.status)) throw new HttpError(409, 'ما بتقدر تلغي الرحلة بهالمرحلة');
    const wasDriver = r.driver_id;
    db.prepare("UPDATE rides SET status='cancelled', cancelled_by='rider' WHERE id=?").run(id);
    notifyRide(id);
    if (wasDriver) push('u:' + wasDriver, 'ride', rideView(rideRow(id), 'driver'));
    // let nearby drivers drop the stale offer
    for (const { d } of nearbyDrivers({ lat: r.pickup_lat, lng: r.pickup_lng })) push('u:' + d.id, 'offer_gone', { id });
  } else {
    if (r.driver_id !== user.id) throw new HttpError(403, 'غير مسموح');
    if (!['accepted', 'arrived'].includes(r.status)) throw new HttpError(409, 'ما بتقدر تلغي الرحلة بهالمرحلة');
    // put the request back in the pool so another driver can take it
    db.prepare("UPDATE rides SET status='requested', driver_id=NULL, accepted_at=NULL, arrived_at=NULL WHERE id=?").run(id);
    push('u:' + user.id, 'ride', { id, status: 'cancelled', cancelled_by: 'driver' });
    const row = rideRow(id);
    push('u:' + row.rider_id, 'ride', { ...rideView(row, 'rider'), notice: 'driver_cancelled' });
    for (const { d } of nearbyDrivers({ lat: row.pickup_lat, lng: row.pickup_lng })) {
      if (d.id !== user.id) push('u:' + d.id, 'offer', offerView(row, d));
    }
  }
  return [200, { ok: true }];
});

// ---- driver
route('POST', '/api/driver/status', 'driver', ({ user, body }) => {
  const online = !!body.online;
  if (online) {
    if (!user.approved) throw new HttpError(403, 'حسابك لسا ما انوافق عليه من الإدارة');
    if (!validPoint(body)) throw new HttpError(400, 'لازم نعرف موقعك عشان تشتغل');
    db.prepare('UPDATE users SET online=1, lat=?, lng=?, loc_at=? WHERE id=?').run(body.lat, body.lng, now(), user.id);
  } else {
    if (driverActiveRide(user.id)) throw new HttpError(409, 'خلّص رحلتك الحالية أول');
    db.prepare('UPDATE users SET online=0 WHERE id=?').run(user.id);
  }
  return [200, { online }];
});

route('POST', '/api/driver/location', 'driver', ({ user, body }) => {
  if (!validPoint(body)) throw new HttpError(400, 'موقع غير صحيح');
  db.prepare('UPDATE users SET lat=?, lng=?, loc_at=? WHERE id=?').run(body.lat, body.lng, now(), user.id);
  const active = driverActiveRide(user.id);
  if (active) {
    const r = db.prepare('SELECT rider_id FROM rides WHERE id=?').get(active.id);
    push('u:' + r.rider_id, 'driver_location', { lat: body.lat, lng: body.lng });
  }
  return [200, { ok: true }];
});

route('GET', '/api/driver/requests', 'driver', ({ user }) => {
  if (!user.online || !user.approved || driverActiveRide(user.id)) return [200, { requests: [] }];
  const s = getSettings();
  const rows = db.prepare("SELECT id FROM rides WHERE status='requested' AND created_at>? ORDER BY id DESC LIMIT 30").all(now() - REQUEST_TTL_MS);
  const out = rows.map((x) => rideRow(x.id))
    .map((r) => offerView(r, user))
    .filter((v) => v.pickup_distance_km <= s.radius_km)
    .sort((a, b) => a.pickup_distance_km - b.pickup_distance_km)
    .slice(0, 10);
  return [200, { requests: out }];
});

route('POST', '/api/rides/:id/accept', 'driver', ({ user, params }) => {
  if (!user.approved || !user.online) throw new HttpError(403, 'لازم تكون متصل ومعتمد');
  if (driverActiveRide(user.id)) throw new HttpError(409, 'عندك رحلة شغّالة');
  const id = Number(params.id);
  const res = db.prepare("UPDATE rides SET status='accepted', driver_id=?, accepted_at=? WHERE id=? AND status='requested'").run(user.id, now(), id);
  if (res.changes !== 1) throw new HttpError(409, 'الطلب انأخذ أو انلغى');
  const row = rideRow(id);
  notifyRide(id);
  for (const { d } of nearbyDrivers({ lat: row.pickup_lat, lng: row.pickup_lng })) {
    if (d.id !== user.id) push('u:' + d.id, 'offer_gone', { id });
  }
  return [200, { ride: rideView(rideRow(id), 'driver') }];
});

function driverTransition(from, to, field) {
  return ({ user, params }) => {
    const id = Number(params.id);
    const res = db.prepare(`UPDATE rides SET status=?, ${field}=? WHERE id=? AND driver_id=? AND status=?`).run(to, now(), id, user.id, from);
    if (res.changes !== 1) throw new HttpError(409, 'ما بتقدر تنفّذ هالخطوة هلأ');
    if (to === 'completed') {
      const r = db.prepare('SELECT fare FROM rides WHERE id=?').get(id);
      db.prepare('UPDATE rides SET commission=? WHERE id=?').run(round2(r.fare * getSettings().commission_rate), id);
    }
    notifyRide(id);
    return [200, { ride: rideView(rideRow(id), 'driver') }];
  };
}
route('POST', '/api/rides/:id/arrived', 'driver', driverTransition('accepted', 'arrived', 'arrived_at'));
route('POST', '/api/rides/:id/start', 'driver', driverTransition('arrived', 'in_progress', 'started_at'));
route('POST', '/api/rides/:id/complete', 'driver', driverTransition('in_progress', 'completed', 'completed_at'));

route('GET', '/api/driver/earnings', 'driver', ({ user }) => {
  const dayStart = Math.floor((now() + TZ_OFFSET_MS) / 86400000) * 86400000 - TZ_OFFSET_MS;
  const q = (since) => db.prepare("SELECT COUNT(*) n, COALESCE(SUM(fare-commission),0) earn FROM rides WHERE driver_id=? AND status='completed' AND completed_at>=?").get(user.id, since);
  const t = q(dayStart), w = q(dayStart - 6 * 86400000);
  return [200, { today: { rides: t.n, earnings: round2(t.earn) }, week: { rides: w.n, earnings: round2(w.earn) }, currency: 'JOD' }];
});

// ---- admin
route('GET', '/api/admin/stats', 'admin', () => {
  const dayStart = Math.floor((now() + TZ_OFFSET_MS) / 86400000) * 86400000 - TZ_OFFSET_MS;
  const t = db.prepare(`SELECT COUNT(*) rides,
      COALESCE(SUM(status='completed'),0) completed,
      COALESCE(SUM(CASE WHEN status='completed' THEN fare END),0) gross,
      COALESCE(SUM(CASE WHEN status='completed' THEN commission END),0) commission
    FROM rides WHERE created_at>=?`).get(dayStart);
  const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a))[0];
  return [200, {
    today: { rides: t.rides, completed: t.completed, gross: round2(t.gross), commission: round2(t.commission) },
    online_drivers: one("SELECT COUNT(*) FROM users WHERE role='driver' AND online=1 AND loc_at>?", now() - LOC_FRESH_MS),
    total_drivers: one("SELECT COUNT(*) FROM users WHERE role='driver'"),
    pending_drivers: one("SELECT COUNT(*) FROM users WHERE role='driver' AND approved=0"),
    total_riders: one("SELECT COUNT(*) FROM users WHERE role='rider'"),
    active_rides: one(`SELECT COUNT(*) FROM rides WHERE status IN ${ACTIVE_RIDER}`),
    currency: 'JOD',
  }];
});

route('GET', '/api/admin/drivers', 'admin', () => {
  const rows = db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM rides r WHERE r.driver_id=u.id AND r.status='completed') AS rides_done,
      (SELECT COALESCE(SUM(fare-commission),0) FROM rides r WHERE r.driver_id=u.id AND r.status='completed') AS earned
    FROM users u WHERE role='driver' ORDER BY approved ASC, id DESC LIMIT 200`).all();
  return [200, {
    drivers: rows.map((u) => ({
      ...publicUser(u), blocked: !!u.blocked, rides_done: u.rides_done, earned: round2(u.earned),
      live: !!(u.online && u.loc_at > now() - LOC_FRESH_MS), lat: u.lat, lng: u.lng, created_at: u.created_at,
    })),
  }];
});

route('POST', '/api/admin/drivers/:id', 'admin', ({ params, body }) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role='driver'").get(Number(params.id));
  if (!u) throw new HttpError(404, 'السائق غير موجود');
  if (typeof body.approved === 'boolean') db.prepare('UPDATE users SET approved=? WHERE id=?').run(body.approved ? 1 : 0, u.id);
  if (typeof body.blocked === 'boolean') {
    db.prepare('UPDATE users SET blocked=?, online=CASE WHEN ?=1 THEN 0 ELSE online END WHERE id=?').run(body.blocked ? 1 : 0, body.blocked ? 1 : 0, u.id);
  }
  return [200, { driver: publicUser(getUser(u.id)) }];
});

route('GET', '/api/admin/rides', 'admin', () => {
  const rows = db.prepare('SELECT id FROM rides ORDER BY id DESC LIMIT 100').all();
  return [200, { rides: rows.map((x) => rideView(rideRow(x.id), 'admin')) }];
});

route('GET', '/api/admin/settings', 'admin', () => [200, { settings: getSettings(), limits: LIMITS }]);
route('POST', '/api/admin/settings', 'admin', ({ body }) => {
  const upd = db.prepare('UPDATE settings SET value=? WHERE key=?');
  for (const [k, v] of Object.entries(body || {})) {
    if (!(k in LIMITS)) continue;
    const n = Number(v);
    const [lo, hi] = LIMITS[k];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `قيمة ${k} لازم تكون بين ${lo} و ${hi}`);
    upd.run(n, k);
  }
  return [200, { settings: getSettings() }];
});

/* ----------------------------------------------------- request handling */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
function baseHeaders(extra = {}) {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extra };
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { reject(new HttpError(413, 'الطلب كبير')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'صيغة الطلب غير صحيحة')); }
    });
    req.on('error', reject);
  });
}
function bearer(req, url) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
}
function userFromToken(token) {
  if (!token || token.length > 100) return null;
  const u = db.prepare('SELECT * FROM users WHERE token=?').get(token);
  return u && !u.blocked ? u : null;
}

function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  if (['/rider', '/driver', '/admin'].includes(pathname)) {
    res.writeHead(301, { Location: pathname + '/' });
    return res.end();
  }
  const route = STATIC_ROUTES.find(({ prefix }) => pathname.startsWith(prefix));
  const root = pathname === '/' ? LANDING_DIR : route && route.root;
  if (!root) {
    res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Not found');
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(route.prefix.length);
  const file = path.resolve(root, rel || 'index.html');
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!path.extname(file) && fs.existsSync(file + '/index.html')) { res.writeHead(301, { Location: url.pathname + '/' }); return res.end(); }
      res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })); return res.end('Not found');
    }
    res.writeHead(200, baseHeaders({ 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }));
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/telegram-webhook') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (!newsroom.configured) throw new HttpError(503, 'Webhook is not configured');
      if (!newsroom.validWebhookSecret(req.headers['x-telegram-bot-api-secret-token'])) {
        throw new HttpError(401, 'Invalid webhook secret');
      }
      const update = await readBody(req);
      await newsroom.handleUpdate(update);
      return sendJson(res, 200, { ok: true });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url);
    }

    // realtime stream
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const user = userFromToken(bearer(req, url));
      if (!user) throw new HttpError(401, 'غير مصرّح');
      res.writeHead(200, baseHeaders({
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      }));
      res.write('retry: 3000\n\n');
      const key = 'u:' + user.id;
      if (!streams.has(key)) streams.set(key, new Set());
      streams.get(key).add(res);
      req.on('close', () => { const s = streams.get(key); if (s) { s.delete(res); if (!s.size) streams.delete(key); } });
      res.write(`event: hello\ndata: ${JSON.stringify({ role: user.role })}\n\n`);
      return;
    }

    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'غير موجود');
    const params = url.pathname.match(r.re).groups || {};
    const token = bearer(req, url);
    let user = null;
    if (r.auth === 'admin') {
      const exp = adminTokens.get(token);
      if (!exp || exp < now()) throw new HttpError(401, 'غير مصرّح');
    } else if (r.auth !== 'none') {
      user = userFromToken(token);
      if (!user) throw new HttpError(401, 'سجّل دخولك من جديد');
      if (r.auth !== 'user' && user.role !== r.auth) throw new HttpError(403, 'غير مسموح');
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const [status, out] = r.handler({ user, params, body, ip: req.socket.remoteAddress || '' });
    sendJson(res, status, out);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'صار خطأ بالسيرفر' });
  }
});

// expire unanswered requests
setInterval(() => {
  const rows = db.prepare("SELECT id FROM rides WHERE status='requested' AND created_at<?").all(now() - REQUEST_TTL_MS);
  for (const { id } of rows) {
    const res = db.prepare("UPDATE rides SET status='expired' WHERE id=? AND status='requested'").run(id);
    if (res.changes === 1) notifyRide(id);
  }
  for (const [t, exp] of adminTokens) if (exp < now()) adminTokens.delete(t);
}, 10000);

newsroom.start();
server.listen(PORT, () => {
  console.log(`Ride app running on http://localhost:${PORT}`);
  console.log('  Rider : /rider/    Driver: /driver/    Admin: /admin/');
});
