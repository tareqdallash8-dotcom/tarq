'use strict';
// End-to-end check of a full ride: register -> approve -> online -> request -> accept -> arrive -> start -> complete -> rate.
// Usage: start the server with `npm start`, then run `npm test` in another terminal.
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const assert = require('node:assert/strict');

if (!ADMIN_PASSWORD) throw new Error('Set ADMIN_PASSWORD in the test environment to test admin login.');

async function staticFile(path) {
  const res = await fetch(BASE + path);
  assert.equal(res.status, 200, `${path} should be served`);
  return res.text();
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.json)); return r.json; };

(async () => {
  const pages = ['/','/rider/','/driver/','/admin/'];
  for (const page of pages) assert.ok((await staticFile(page)).includes('<!doctype html>'), `${page} should serve an app page`);
  for (const asset of ['/rider/app.js','/driver/app.js','/admin/app.js','/shared/lib.js','/shared/style.css','/shared/icon.svg']) {
    assert.ok((await staticFile(asset)).length > 0, `${asset} should serve an asset`);
  }
  for (const app of ['/rider','/driver','/admin']) {
    const res = await fetch(BASE + app, { redirect: 'manual' });
    assert.equal(res.status, 301, `${app} should redirect to its app directory`);
    assert.equal(res.headers.get('location'), app + '/');
  }
  console.log('served landing page, apps, and shared assets');

  const stamp = String(Date.now()).slice(-7);
  const amman = { lat: 31.9539, lng: 35.9106 }; // downtown Amman
  const sweileh = { lat: 32.0237, lng: 35.8700 };

  const rider = ok(await api('POST', '/api/register', { body: { role: 'rider', name: 'راكب تجريبي', phone: '0790' + stamp, pin: '1234' } }), 201);
  const driver = ok(await api('POST', '/api/register', { body: { role: 'driver', name: 'كابتن تجريبي', phone: '0780' + stamp, pin: '4321', car: 'Kia Picanto', plate: '10-12345' } }), 201);
  console.log('registered rider + driver');

  // duplicate + wrong login + bad input
  assert.equal((await api('POST', '/api/register', { body: { role: 'rider', name: 'x', phone: '0790' + stamp, pin: '1234' } })).status, 400);
  assert.equal((await api('POST', '/api/login', { body: { role: 'rider', phone: '0790' + stamp, pin: '9999' } })).status, 401);
  ok(await api('POST', '/api/login', { body: { role: 'rider', phone: '0790' + stamp, pin: '1234' } }));

  // unapproved driver cannot go online
  assert.equal((await api('POST', '/api/driver/status', { token: driver.token, body: { online: true, ...amman } })).status, 403);

  // role isolation
  assert.equal((await api('POST', '/api/rides', { token: driver.token, body: { pickup: amman, drop: sweileh } })).status, 403);
  assert.equal((await api('GET', '/api/admin/stats', { token: rider.token })).status, 401);

  // admin approves driver
  const admin = ok(await api('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } }));
  ok(await api('POST', '/api/admin/drivers/' + driver.user.id, { token: admin.token, body: { approved: true } }));
  ok(await api('POST', '/api/driver/status', { token: driver.token, body: { online: true, lat: amman.lat + 0.005, lng: amman.lng } }));
  console.log('driver approved + online');

  // estimate + request
  const est = ok(await api('POST', '/api/rides/estimate', { token: rider.token, body: { pickup: amman, drop: sweileh } }));
  assert.ok(est.fare >= 1 && est.drivers_nearby === 1, JSON.stringify(est));
  console.log('estimate:', est);

  const created = ok(await api('POST', '/api/rides', { token: rider.token, body: { pickup: { ...amman, name: 'وسط البلد' }, drop: { ...sweileh, name: 'الصويلح' } } }), 201);
  const id = created.ride.id;
  assert.equal(created.ride.fare, est.fare);
  assert.equal((await api('POST', '/api/rides', { token: rider.token, body: { pickup: amman, drop: sweileh } })).status, 409, 'second active ride must be rejected');

  const reqs = ok(await api('GET', '/api/driver/requests', { token: driver.token }));
  assert.equal(reqs.requests.length, 1);
  assert.equal(reqs.requests[0].rider, undefined, 'rider contact hidden before accept');

  ok(await api('POST', `/api/rides/${id}/accept`, { token: driver.token }));
  const other = ok(await api('POST', '/api/register', { body: { role: 'driver', name: 'كابتن ثاني', phone: '0770' + stamp, pin: '1111', car: 'Hyundai', plate: '20-1' } }), 201);
  ok(await api('POST', '/api/admin/drivers/' + other.user.id, { token: admin.token, body: { approved: true } }));
  ok(await api('POST', '/api/driver/status', { token: other.token, body: { online: true, ...amman } }));
  assert.equal((await api('POST', `/api/rides/${id}/accept`, { token: other.token })).status, 409, 'ride already taken');

  // out-of-order transitions are rejected
  assert.equal((await api('POST', `/api/rides/${id}/complete`, { token: driver.token })).status, 409);
  ok(await api('POST', '/api/driver/location', { token: driver.token, body: amman }));
  ok(await api('POST', `/api/rides/${id}/arrived`, { token: driver.token }));
  ok(await api('POST', `/api/rides/${id}/start`, { token: driver.token }));
  const done = ok(await api('POST', `/api/rides/${id}/complete`, { token: driver.token }));
  assert.equal(done.ride.status, 'completed');
  assert.ok(done.ride.commission > 0);

  ok(await api('POST', `/api/rides/${id}/rate`, { token: rider.token, body: { stars: 5 } }));
  assert.equal((await api('POST', `/api/rides/${id}/rate`, { token: rider.token, body: { stars: 4 } })).status, 409, 'cannot rate twice');
  console.log('ride completed, fare', done.ride.fare, 'JOD, commission', done.ride.commission);

  const earn = ok(await api('GET', '/api/driver/earnings', { token: driver.token }));
  assert.equal(earn.today.rides >= 1, true);
  const stats = ok(await api('GET', '/api/admin/stats', { token: admin.token }));
  assert.ok(stats.today.completed >= 1);
  const me = ok(await api('GET', '/api/me', { token: rider.token }));
  assert.equal(me.ride, null);

  // cancel flow
  const c2 = ok(await api('POST', '/api/rides', { token: rider.token, body: { pickup: amman, drop: sweileh } }), 201);
  ok(await api('POST', `/api/rides/${c2.ride.id}/cancel`, { token: rider.token }));

  // settings validation
  assert.equal((await api('POST', '/api/admin/settings', { token: admin.token, body: { per_km: -1 } })).status, 400);
  ok(await api('POST', '/api/admin/settings', { token: admin.token, body: { per_km: 0.35 } }));
  ok(await api('POST', '/api/admin/settings', { token: admin.token, body: { per_km: 0.3 } }));

  console.log('\nALL CHECKS PASSED');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
