(function () {
  'use strict';
  const { h, clear, toast, jod, km } = RA;
  const app = document.getElementById('app');

  let token = RA.store.get('rider_token');
  let user = null;
  let ride = null; // active ride (server view)
  let done = null; // finished ride being shown (completed / expired)
  let map = null, events = null, pollTimer = null;
  const markers = {};
  let pickup = null, drop = null, mode = 'drop'; // mode = which point a map tap sets
  let quoteData = null, quoteKey = '';
  let searchTimer = null;

  const api = RA.client(() => token, () => logout());

  function logout() {
    RA.store.del('rider_token');
    token = null;
    if (events) events.close();
    location.reload();
  }

  /* ------------------------------------------------------------ boot */
  function start() {
    if (!token) {
      clear(app).append(RA.authView('rider', (res) => {
        token = res.token;
        RA.store.set('rider_token', token);
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
      user = me.user;
      ride = me.ride;
    } catch (e) {
      if (token) toast(e.message, true);
      return;
    }
    app.append(
      h('div', { id: 'map' }),
      h('div', { class: 'topbar' },
        h('button', { class: 'chip', onClick: () => { if (confirm('تسجيل خروج؟')) logout(); } }, '👤 ' + user.name),
        h('button', { class: 'chip', onClick: locateMe }, '📍 موقعي')),
      h('div', { id: 'sheet', class: 'sheet' }));

    map = RA.makeMap('map', RA.AMMAN, 13);
    map.on('click', (e) => {
      if (ride || done) return;
      setPoint(mode, { lat: e.latlng.lat, lng: e.latlng.lng, name: 'الموقع المحدد' });
      mode = 'drop';
    });

    events = RA.events(token, {
      ride: (v) => {
        if (v.notice === 'driver_cancelled') toast('الكابتن لغى، عم ندوّر على غيره');
        applyRide(v);
      },
      driver_location: (p) => {
        if (ride && ride.driver) { ride.driver.lat = p.lat; ride.driver.lng = p.lng; moveDriver(); }
      },
    });
    pollTimer = setInterval(sync, 10000);

    if (!ride) {
      const here = await RA.locate();
      if (here) pickup = { ...here, name: 'موقعي الحالي' };
      else { pickup = { ...RA.AMMAN, name: 'وسط عمّان' }; toast('فعّل خدمة الموقع أو حدّد نقطة الانطلاق على الخريطة'); }
      map.setView([pickup.lat, pickup.lng], 15);
    }
    render();
  }

  async function sync() {
    if (done) return;
    try {
      const me = await api('GET', '/api/me');
      const a = JSON.stringify(me.ride), b = JSON.stringify(ride);
      if (a !== b) {
        if (!me.ride && ride) { // ride vanished while we were offline: look it up in history
          const hist = await api('GET', '/api/rides/history');
          const last = hist.rides.find((x) => x.id === ride.id);
          if (last) return applyRide(last);
        }
        ride = me.ride;
        render();
      }
    } catch { /* offline, try again next tick */ }
  }

  async function locateMe() {
    const here = await RA.locate();
    if (!here) return toast('ما قدرنا نحدد موقعك', true);
    map.setView([here.lat, here.lng], 16);
    if (!ride && !done) setPoint('pickup', { ...here, name: 'موقعي الحالي' });
  }

  /* ----------------------------------------------------- state changes */
  function applyRide(v) {
    if (v.status === 'completed') { done = v; ride = null; }
    else if (v.status === 'expired') { ride = null; toast('ما لقينا كابتن متاح، جرّب مرة ثانية', true); }
    else if (v.status === 'cancelled') { ride = null; toast('انلغت الرحلة'); }
    else ride = v;
    render();
  }

  function setPoint(which, p) {
    if (which === 'pickup') pickup = p; else drop = p;
    render();
    RA.reverse(p).then((name) => {
      const cur = which === 'pickup' ? pickup : drop;
      if (name && cur === p) { p.name = name; if (!ride && !done) render(); }
    });
  }

  /* ----------------------------------------------------------- render */
  function render() {
    const sheet = document.getElementById('sheet');
    if (!sheet) return;
    clear(sheet);
    if (done) { renderDone(sheet); syncMarkers(null, null, null, false); return; }
    if (ride) { renderRide(sheet); return; }
    renderIdle(sheet);
  }

  function setMarker(key, latlng, icon) {
    if (!latlng) { if (markers[key]) { map.removeLayer(markers[key]); delete markers[key]; } return; }
    if (markers[key]) markers[key].setLatLng([latlng.lat, latlng.lng]);
    else markers[key] = L.marker([latlng.lat, latlng.lng], { icon }).addTo(map);
  }
  function syncMarkers(from, to, driver, fit) {
    setMarker('from', from, RA.pin('from'));
    setMarker('to', to, RA.pin('to'));
    setMarker('driver', driver, RA.carIcon());
    if (fit) {
      const pts = [from, to, driver].filter(Boolean).map((p) => [p.lat, p.lng]);
      if (pts.length > 1) map.fitBounds(pts, { padding: [60, 60], maxZoom: 16 });
      else if (pts.length === 1) map.setView(pts[0], 15);
    }
  }
  function moveDriver() {
    if (ride && ride.driver && ride.driver.lat != null) setMarker('driver', ride.driver, RA.carIcon());
  }

  function routeBlock(from, to) {
    return h('div', { class: 'route' },
      h('div', { class: 'stop' }, from || 'نقطة الانطلاق'),
      h('div', { class: 'stop to' }, to || 'الوجهة'));
  }

  /* ---- idle: choose destination, see price, request */
  function renderIdle(sheet) {
    syncMarkers(pickup, drop, null, false);

    const results = h('div');
    const input = h('input', {
      placeholder: 'ابحث عن وجهتك (مثال: الجامعة الأردنية)', value: drop ? drop.name : '',
      autocomplete: 'off',
      onInput: () => {
        clearTimeout(searchTimer);
        const q = input.value.trim();
        clear(results);
        if (q.length < 3) return;
        searchTimer = setTimeout(async () => {
          try {
            const rows = await RA.search(q);
            clear(results);
            if (!rows.length) { results.append(h('div', { class: 'empty' }, 'ما لقينا نتائج، جرّب تضغط على الخريطة')); return; }
            results.append(h('div', { class: 'results' }, rows.map((r) => h('button', {
              type: 'button',
              onClick: () => { setPoint('drop', r); map.setView([r.lat, r.lng], 15); },
            }, r.name))));
          } catch (e) { toast(e.message, true); }
        }, 600);
      },
    });

    const quoteBox = h('div');
    const reqBtn = h('button', { class: 'btn', disabled: true }, 'اطلب كابتن');

    sheet.append(
      h('h2', null, 'وين رايح؟'),
      h('p', { class: 'sub' }, 'اكتب الوجهة أو اضغط عليها بالخريطة. الدفع كاش للكابتن.'),
      h('div', { class: 'card row', style: { marginBottom: '10px' } },
        h('div', { class: 'grow' }, h('div', { class: 'sub', style: { margin: 0, fontSize: '12px' } }, 'من'), h('b', null, pickup ? pickup.name : '...')),
        h('button', { class: 'btn ghost sm', onClick: () => { mode = 'pickup'; toast('اضغط على الخريطة لتحديد نقطة الانطلاق'); } }, 'غيّر')),
      h('label', { class: 'field' }, h('span', null, 'إلى'), input),
      results,
      quoteBox,
      h('div', { style: { marginTop: '12px' } }, reqBtn));

    if (!drop || !pickup) return;
    const key = `${pickup.lat},${pickup.lng}|${drop.lat},${drop.lng}`;
    const showQuote = (q) => {
      clear(quoteBox).append(h('div', { class: 'card', style: { marginTop: '10px' } },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'sub', style: { margin: 0 } }, 'الأجرة'), h('div', { class: 'big' }, jod(q.fare))),
          h('div', { style: { textAlign: 'end', fontSize: '14px', color: 'var(--ink-2)' } },
            h('div', null, km(q.distance_km) + ' • ~' + q.eta_min + ' دقيقة'),
            h('div', null, q.drivers_nearby ? `🚕 ${q.drivers_nearby} كابتن قريب` : 'ما في كباتن قريبين هلأ')))));
      reqBtn.disabled = false;
    };
    reqBtn.addEventListener('click', async () => {
      reqBtn.disabled = true;
      try {
        const res = await api('POST', '/api/rides', { pickup, drop });
        applyRide(res.ride);
      } catch (e) { toast(e.message, true); reqBtn.disabled = false; }
    });
    if (quoteKey === key && quoteData) showQuote(quoteData);
    else {
      quoteBox.append(h('div', { class: 'empty' }, 'عم نحسب الأجرة...'));
      api('POST', '/api/rides/estimate', { pickup, drop }).then((q) => {
        quoteData = q; quoteKey = key;
        if (document.body.contains(quoteBox)) showQuote(q);
      }).catch((e) => { clear(quoteBox).append(h('div', { class: 'empty' }, e.message)); });
    }
  }

  /* ---- active ride */
  function renderRide(sheet) {
    const r = ride;
    syncMarkers(r.pickup, r.drop, r.driver && r.driver.lat != null ? r.driver : null, true);
    sheet.append(h('h2', null, RA.statusText[r.status] || ''));

    if (r.status === 'requested') {
      sheet.append(
        h('div', { class: 'spinner' }),
        h('p', { class: 'sub', style: { textAlign: 'center' } }, 'بنبعت طلبك للكباتن القريبين، ثواني...'),
        routeBlock(r.pickup.name, r.drop.name),
        h('div', { class: 'kv' }, h('span', null, 'الأجرة (كاش)'), h('b', null, jod(r.fare))));
    } else {
      if (r.driver) {
        sheet.append(h('div', { class: 'card row', style: { marginBottom: '10px' } },
          h('div', { class: 'grow' },
            h('b', null, r.driver.name + (r.driver.rating ? '  ★ ' + r.driver.rating : '')),
            h('div', { class: 'sub', style: { margin: 0 } }, `${r.driver.car} • ${r.driver.plate}`)),
          h('a', { class: 'btn dark sm', href: 'tel:' + r.driver.phone }, '📞 اتصل')));
      }
      sheet.append(
        routeBlock(r.pickup.name, r.drop.name),
        h('div', { class: 'kv' }, h('span', null, 'ادفع للكابتن كاش'), h('b', null, jod(r.fare))));
    }

    if (['requested', 'accepted', 'arrived'].includes(r.status)) {
      sheet.append(h('div', { style: { marginTop: '12px' } }, h('button', {
        class: 'btn danger',
        onClick: async () => {
          if (!confirm('تأكيد إلغاء الرحلة؟')) return;
          try { await api('POST', `/api/rides/${r.id}/cancel`); } catch (e) { toast(e.message, true); }
        },
      }, 'إلغاء الرحلة')));
    }
  }

  /* ---- finished ride: pay + rate */
  function renderDone(sheet) {
    let stars = 0;
    const starRow = h('div', { class: 'stars' });
    const send = h('button', { class: 'btn', disabled: true }, 'إرسال التقييم');
    const paint = () => {
      clear(starRow).append([1, 2, 3, 4, 5].map((n) => h('button', {
        type: 'button', class: n <= stars ? 'on' : '', 'aria-label': n + ' نجوم',
        onClick: () => { stars = n; send.disabled = false; paint(); },
      }, '★')));
    };
    paint();
    const finish = () => { done = null; drop = null; quoteData = null; quoteKey = ''; render(); };
    send.addEventListener('click', async () => {
      send.disabled = true;
      try { await api('POST', `/api/rides/${done.id}/rate`, { stars }); toast('شكراً لتقييمك'); finish(); }
      catch (e) { toast(e.message, true); send.disabled = false; }
    });
    sheet.append(
      h('h2', null, 'وصلت بالسلامة 🎉'),
      h('div', { class: 'card', style: { textAlign: 'center', margin: '8px 0 14px' } },
        h('div', { class: 'sub', style: { margin: 0 } }, 'ادفع للكابتن كاش'),
        h('div', { class: 'big' }, jod(done.fare))),
      h('p', { class: 'sub', style: { textAlign: 'center' } }, 'كيف كانت الرحلة مع ' + (done.driver ? done.driver.name : 'الكابتن') + '؟'),
      starRow,
      h('div', { class: 'stack', style: { marginTop: '14px' } }, send, h('button', { class: 'btn ghost', onClick: finish }, 'تخطي')));
  }

  start();
})();
