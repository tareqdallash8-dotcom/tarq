(function () {
  'use strict';
  const { h, clear, toast, jod, km } = RA;
  const app = document.getElementById('app');

  let token = RA.store.get('driver_token');
  let user = null, ride = null, online = false;
  let requests = [], earnings = null;
  let map = null, events = null, pollTimer = null, locTimer = null, watchId = null;
  let here = null; // last GPS fix
  const markers = {};
  let lastRideKey = '';

  const api = RA.client(() => token, () => logout());

  function logout() {
    RA.store.del('driver_token');
    token = null;
    if (events) events.close();
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    location.reload();
  }

  function start() {
    if (!token) {
      clear(app).append(RA.authView('driver', (res) => {
        token = res.token;
        RA.store.set('driver_token', token);
        boot();
      }));
      return;
    }
    boot();
  }

  async function boot() {
    clear(app);
    try {
      const me = await api('GET', '/api/me');
      user = me.user; ride = me.ride; online = user.online;
    } catch (e) {
      if (token) toast(e.message, true);
      return;
    }
    app.append(
      h('div', { id: 'map' }),
      h('div', { class: 'topbar' },
        h('button', { class: 'chip', onClick: () => { if (confirm('تسجيل خروج؟')) logout(); } }, '👤 ' + user.name),
        h('button', { class: 'chip', id: 'onlineChip', onClick: toggleOnline })),
      h('div', { id: 'sheet', class: 'sheet' }));

    map = RA.makeMap('map', RA.AMMAN, 13);
    startWatch();

    events = RA.events(token, {
      offer: (v) => {
        if (!online || ride) return;
        requests = [v, ...requests.filter((r) => r.id !== v.id)].sort((a, b) => a.pickup_distance_km - b.pickup_distance_km);
        RA.beep();
        render();
      },
      offer_gone: (v) => { requests = requests.filter((r) => r.id !== v.id); render(); },
      ride: (v) => {
        if (v.status === 'cancelled') {
          if (v.cancelled_by === 'rider') toast('الراكب لغى الرحلة', true);
          ride = null;
        } else if (v.status === 'completed') ride = null;
        else ride = v;
        render();
      },
    });

    // if the server still thinks we're online, resume sharing our location (or go offline if we can't)
    if (online) {
      const pos = await RA.locate();
      if (pos) { here = pos; api('POST', '/api/driver/location', pos).catch(() => {}); }
      else { await api('POST', '/api/driver/status', { online: false }).catch(() => {}); online = false; }
    }
    pollTimer = setInterval(tick, 6000);
    loadEarnings();
    if (online && !ride) refreshRequests();
    render();
  }

  /* ------------------------------------------------------ location */
  function startWatch() {
    if (!navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition((p) => {
      here = { lat: p.coords.latitude, lng: p.coords.longitude };
      setMarker('me', here, RA.carIcon());
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
    locTimer = setInterval(() => {
      if (online && here) api('POST', '/api/driver/location', here).catch(() => {});
    }, 5000);
  }

  /* ---------------------------------------------------- data loads */
  async function loadEarnings() {
    try { earnings = await api('GET', '/api/driver/earnings'); render(); } catch { /* ignore */ }
  }
  async function refreshRequests() {
    try {
      const r = await api('GET', '/api/driver/requests');
      const before = requests.map((x) => x.id).join();
      requests = r.requests;
      if (requests.map((x) => x.id).join() !== before) render();
    } catch { /* ignore */ }
  }
  async function tick() {
    if (!online) return;
    if (ride) {
      try {
        const me = await api('GET', '/api/me');
        if (JSON.stringify(me.ride) !== JSON.stringify(ride)) { ride = me.ride; render(); }
      } catch { /* ignore */ }
    } else refreshRequests();
  }

  /* ---------------------------------------------------- online toggle */
  async function toggleOnline() {
    if (ride) return toast('خلّص رحلتك الحالية أول', true);
    try {
      if (online) {
        await api('POST', '/api/driver/status', { online: false });
        online = false; requests = [];
      } else {
        if (!user.approved) return toast('حسابك قيد المراجعة من الإدارة', true);
        RA.beep(); // unlocks audio so new-request alerts can play
        const pos = here || (await RA.locate());
        if (!pos) return toast('لازم تفعّل الموقع عشان تشتغل', true);
        here = pos;
        await api('POST', '/api/driver/status', { online: true, ...pos });
        online = true;
        map.setView([pos.lat, pos.lng], 15);
        refreshRequests();
      }
      render();
    } catch (e) { toast(e.message, true); }
  }

  /* ----------------------------------------------------------- render */
  function setMarker(key, p, icon) {
    if (!map) return;
    if (!p) { if (markers[key]) { map.removeLayer(markers[key]); delete markers[key]; } return; }
    if (markers[key]) markers[key].setLatLng([p.lat, p.lng]);
    else markers[key] = L.marker([p.lat, p.lng], { icon }).addTo(map);
  }

  function routeBlock(from, to) {
    return h('div', { class: 'route' },
      h('div', { class: 'stop' }, from || 'نقطة الانطلاق'),
      h('div', { class: 'stop to' }, to || 'الوجهة'));
  }

  function render() {
    const sheet = document.getElementById('sheet');
    const chip = document.getElementById('onlineChip');
    if (!sheet) return;
    chip.textContent = online ? '🟢 متصل' : '⚪ غير متصل';
    clear(sheet);
    if (ride) return renderRide(sheet);
    setMarker('from', null); setMarker('to', null);
    lastRideKey = '';
    if (!online) return renderOffline(sheet);
    renderWaiting(sheet);
  }

  function earningsCard() {
    if (!earnings) return null;
    return h('div', { class: 'card row', style: { marginBottom: '10px' } },
      h('div', { class: 'grow' }, h('div', { class: 'sub', style: { margin: 0, fontSize: '12px' } }, 'ربحك اليوم'), h('b', null, jod(earnings.today.earnings) + ' • ' + earnings.today.rides + ' رحلة')),
      h('div', { class: 'grow', style: { textAlign: 'end' } }, h('div', { class: 'sub', style: { margin: 0, fontSize: '12px' } }, 'آخر 7 أيام'), h('b', null, jod(earnings.week.earnings))));
  }

  function renderOffline(sheet) {
    sheet.append(
      h('h2', null, 'جاهز تشتغل؟'),
      h('p', { class: 'sub' }, user.approved ? 'اضغط ابدأ لتستقبل طلبات الركاب القريبين منك.' : 'حسابك قيد المراجعة. بنفعّله بأقرب وقت بعد ما الإدارة تراجع بياناتك.'),
      earningsCard(),
      user.approved
        ? h('button', { class: 'btn', onClick: toggleOnline }, 'ابدأ الشغل')
        : h('span', { class: 'pill warn' }, 'بانتظار الموافقة'));
  }

  function renderWaiting(sheet) {
    sheet.append(h('h2', null, requests.length ? 'طلبات قريبة منك' : 'بانتظار الطلبات...'), earningsCard());
    if (!requests.length) {
      sheet.append(h('div', { class: 'spinner' }), h('p', { class: 'empty' }, 'ضلّك على هالصفحة، بينبّهك صوت لما ينزل طلب.'));
    }
    for (const r of requests) {
      sheet.append(h('div', { class: 'card stack', style: { marginBottom: '10px' } },
        routeBlock(r.pickup.name, r.drop.name),
        h('div', { class: 'kv' }, h('span', null, `${km(r.pickup_distance_km)} لعندك • الرحلة ${km(r.distance_km)}`), h('b', null, 'ربحك ' + jod(r.driver_earning))),
        h('button', {
          class: 'btn',
          onClick: async (e) => {
            e.target.disabled = true;
            try {
              const res = await api('POST', `/api/rides/${r.id}/accept`);
              requests = []; ride = res.ride; render();
            } catch (ex) {
              toast(ex.message, true);
              requests = requests.filter((x) => x.id !== r.id); render();
            }
          },
        }, 'اقبل الطلب')));
    }
    sheet.append(h('button', { class: 'btn ghost', style: { marginTop: '4px' }, onClick: toggleOnline }, 'إيقاف استقبال الطلبات'));
  }

  const NEXT = {
    accepted: { label: 'وصلت لمكان الراكب', path: 'arrived' },
    arrived: { label: 'ابدأ الرحلة', path: 'start' },
    in_progress: { label: 'أنهِ الرحلة', path: 'complete' },
  };
  const TITLE = { accepted: 'روح لمكان الراكب', arrived: 'بانتظار الراكب', in_progress: 'الرحلة شغّالة' };

  function renderRide(sheet) {
    const r = ride;
    const target = r.status === 'in_progress' ? r.drop : r.pickup;
    setMarker('from', r.pickup, RA.pin('from'));
    setMarker('to', r.drop, RA.pin('to'));
    const key = r.id + ':' + r.status;
    if (key !== lastRideKey) {
      lastRideKey = key;
      const pts = [here, target].filter(Boolean).map((p) => [p.lat, p.lng]);
      if (pts.length > 1) map.fitBounds(pts, { padding: [70, 70], maxZoom: 16 });
      else if (pts.length) map.setView(pts[0], 15);
    }

    const next = NEXT[r.status];
    const nav = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${target.lat},${target.lng}`;
    sheet.append(
      h('h2', null, TITLE[r.status] || ''),
      r.rider ? h('div', { class: 'card row', style: { marginBottom: '10px' } },
        h('div', { class: 'grow' }, h('b', null, r.rider.name), h('div', { class: 'sub', style: { margin: 0 } }, 'الراكب')),
        h('a', { class: 'btn dark sm', href: 'tel:' + r.rider.phone }, '📞 اتصل')) : null,
      routeBlock(r.pickup.name, r.drop.name),
      h('div', { class: 'card', style: { textAlign: 'center', margin: '10px 0' } },
        h('div', { class: 'sub', style: { margin: 0 } }, 'استلم من الراكب كاش'),
        h('div', { class: 'big' }, jod(r.fare))),
      h('div', { class: 'stack' },
        h('a', { class: 'btn dark', href: nav, target: '_blank', rel: 'noopener' }, '🧭 افتح الملاحة'),
        next ? h('button', {
          class: r.status === 'in_progress' ? 'btn ok' : 'btn',
          onClick: async (e) => {
            if (r.status === 'in_progress' && !confirm('تأكيد إنهاء الرحلة واستلام ' + jod(r.fare) + ' كاش؟')) return;
            e.target.disabled = true;
            try {
              const res = await api('POST', `/api/rides/${r.id}/${next.path}`);
              if (res.ride.status === 'completed') {
                toast('تمام! ربحك من الرحلة ' + jod(res.ride.fare - res.ride.commission));
                ride = null; loadEarnings();
              } else ride = res.ride;
              render();
            } catch (ex) { toast(ex.message, true); e.target.disabled = false; }
          },
        }, r.status === 'in_progress' ? 'أنهِ الرحلة واستلمت الكاش' : next.label) : null,
        ['accepted', 'arrived'].includes(r.status) ? h('button', {
          class: 'btn danger',
          onClick: async () => {
            if (!confirm('تأكيد الإلغاء؟ الطلب بيرجع لباقي الكباتن.')) return;
            try { await api('POST', `/api/rides/${r.id}/cancel`); } catch (ex) { toast(ex.message, true); }
          },
        }, 'إلغاء الرحلة') : null));
  }

  start();
})();
