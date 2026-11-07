(function () {
  'use strict';
  const { h, clear, toast, jod } = RA;
  const app = document.getElementById('app');

  // admin token lives only for the browser session
  const ses = {
    get() { try { return sessionStorage.getItem('ra_admin'); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('ra_admin', v); } catch { /* ignore */ } },
    del() { try { sessionStorage.removeItem('ra_admin'); } catch { /* ignore */ } },
  };
  let token = ses.get();
  let tab = 'overview';
  let map = null, mapMarkers = [];
  let timer = null;
  const api = RA.client(() => token, () => logout());

  const TABS = [['overview', 'نظرة عامة'], ['drivers', 'الكباتن'], ['rides', 'الرحلات'], ['settings', 'الأسعار']];
  const fmtTime = (t) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Amman', dateStyle: 'short', timeStyle: 'short' }) : '-');
  const RIDE_PILL = { completed: 'ok', in_progress: 'warn', accepted: 'warn', arrived: 'warn', requested: 'warn', cancelled: 'bad', expired: 'bad' };

  function logout() {
    ses.del(); token = null;
    if (timer) clearInterval(timer);
    show();
  }

  function show() {
    if (!token) return renderLogin();
    renderShell();
  }

  function renderLogin() {
    clear(app);
    const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'كلمة السر' });
    const err = h('div', { class: 'err-text' });
    app.append(h('form', {
      class: 'login stack',
      onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          const res = await RA.client(() => null)('POST', '/api/admin/login', { password: pw.value });
          token = res.token; ses.set(token); show();
        } catch (ex) { err.textContent = ex.message; }
      },
    }, h('h1', { style: { textAlign: 'center' } }, 'Volt | الإدارة'),
    h('label', { class: 'field' }, h('span', null, 'كلمة السر'), pw), err,
    h('button', { class: 'btn', type: 'submit' }, 'دخول')));
  }

  function renderShell() {
    clear(app);
    if (map) { map.remove(); map = null; }
    const content = h('div', { id: 'content' });
    app.append(h('div', { class: 'wrap' },
      h('div', { class: 'head' }, h('h1', null, '🚕 Volt | الإدارة'), h('button', { class: 'btn ghost sm', onClick: logout }, 'خروج')),
      h('div', { class: 'nav' }, TABS.map(([k, label]) => h('button', {
        class: k === tab ? 'on' : '', onClick: () => { tab = k; renderShell(); },
      }, label))),
      content));
    if (timer) clearInterval(timer);
    load();
    if (tab !== 'settings') timer = setInterval(load, 5000);
  }

  async function load() {
    const content = document.getElementById('content');
    if (!content) return;
    try {
      if (tab === 'overview') await overview(content);
      else if (tab === 'drivers') await drivers(content);
      else if (tab === 'rides') await rides(content);
      else await settings(content);
    } catch (e) { if (token) toast(e.message, true); }
  }

  const tile = (n, l) => h('div', { class: 'tile' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));

  async function overview(content) {
    const [s, d] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/drivers')]);
    if (!map) {
      clear(content).append(h('div', { class: 'tiles', id: 'tiles' }), h('div', { class: 'panel' }, h('b', null, 'الكباتن المتصلين هلأ'), h('div', { id: 'adminmap' })));
      map = RA.makeMap('adminmap', RA.AMMAN, 12);
    }
    const tiles = document.getElementById('tiles');
    clear(tiles).append(
      tile(s.today.rides, 'طلبات اليوم'),
      tile(s.today.completed, 'رحلات مكتملة اليوم'),
      tile(jod(s.today.gross), 'إجمالي المبيعات اليوم'),
      tile(jod(s.today.commission), 'عمولة الشركة اليوم'),
      tile(s.online_drivers, 'كباتن متصلين'),
      tile(s.active_rides, 'رحلات جارية'),
      tile(s.pending_drivers, 'كباتن بانتظار الموافقة'),
      tile(`${s.total_drivers} / ${s.total_riders}`, 'كباتن / ركاب (الكل)'));
    mapMarkers.forEach((m) => map.removeLayer(m));
    mapMarkers = d.drivers.filter((x) => x.live && x.lat != null).map((x) =>
      L.marker([x.lat, x.lng], { icon: RA.carIcon() }).bindPopup(makePopup(x)).addTo(map));
    if (mapMarkers.length && !map._fitted) { map.fitBounds(mapMarkers.map((m) => m.getLatLng()), { padding: [40, 40], maxZoom: 14 }); map._fitted = true; }
  }

  function makePopup(x) {
    return h('div', { dir: 'rtl' }, h('b', null, x.name), h('div', null, `${x.car} • ${x.plate}`));
  }

  async function drivers(content) {
    const d = await api('GET', '/api/admin/drivers');
    const act = async (id, body) => {
      try { await api('POST', '/api/admin/drivers/' + id, body); load(); } catch (e) { toast(e.message, true); }
    };
    const statusPill = (x) => (x.blocked ? h('span', { class: 'pill bad' }, 'موقوف')
      : !x.approved ? h('span', { class: 'pill warn' }, 'بانتظار الموافقة')
        : x.live ? h('span', { class: 'pill ok' }, 'متصل') : h('span', { class: 'pill' }, 'غير متصل'));
    clear(content).append(h('div', { class: 'panel tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['الاسم', 'الهاتف', 'السيارة', 'الحالة', 'التقييم', 'رحلات', 'أرباحه', 'سجّل', ''].map((t) => h('th', null, t)))),
      h('tbody', null, d.drivers.length ? d.drivers.map((x) => h('tr', null,
        h('td', null, x.name), h('td', { dir: 'ltr' }, x.phone), h('td', null, `${x.car} • ${x.plate}`),
        h('td', null, statusPill(x)), h('td', null, x.rating ? '★ ' + x.rating : '-'),
        h('td', null, x.rides_done), h('td', null, jod(x.earned)), h('td', null, fmtTime(x.created_at)),
        h('td', null, h('div', { class: 'row' },
          !x.approved ? h('button', { class: 'btn ok sm', onClick: () => act(x.id, { approved: true }) }, 'موافقة') : null,
          x.blocked
            ? h('button', { class: 'btn ghost sm', onClick: () => act(x.id, { blocked: false }) }, 'رفع الإيقاف')
            : h('button', { class: 'btn danger sm', onClick: () => { if (confirm('إيقاف هذا الكابتن؟')) act(x.id, { blocked: true }); } }, 'إيقاف'))))
      ) : h('tr', null, h('td', { colspan: 9, class: 'empty' }, 'ما في كباتن مسجلين بعد'))))));
  }

  async function rides(content) {
    const d = await api('GET', '/api/admin/rides');
    clear(content).append(h('div', { class: 'panel tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['#', 'الوقت', 'الراكب', 'الكابتن', 'من ← إلى', 'المسافة', 'الأجرة', 'العمولة', 'الحالة'].map((t) => h('th', null, t)))),
      h('tbody', null, d.rides.length ? d.rides.map((r) => h('tr', null,
        h('td', null, r.id), h('td', null, fmtTime(r.created_at)), h('td', null, r.rider_name), h('td', null, r.driver_name || '-'),
        h('td', null, `${r.pickup.name || 'نقطة'} ← ${r.drop.name || 'نقطة'}`),
        h('td', null, r.distance_km + ' كم'), h('td', null, jod(r.fare)),
        h('td', null, r.status === 'completed' ? jod(r.commission) : '-'),
        h('td', null, h('span', { class: 'pill ' + (RIDE_PILL[r.status] || '') }, RA.statusText[r.status] || r.status)))
      ) : h('tr', null, h('td', { colspan: 9, class: 'empty' }, 'ما في رحلات بعد'))))));
  }

  const SETTING_FIELDS = [
    ['base_fare', 'رسوم فتح العداد (د.أ)', 1, 0.05],
    ['per_km', 'سعر الكيلومتر (د.أ)', 1, 0.01],
    ['min_fare', 'الحد الأدنى للأجرة (د.أ)', 1, 0.05],
    ['commission_rate', 'عمولة الشركة (%)', 100, 1],
    ['radius_km', 'نطاق البحث عن كابتن (كم)', 1, 0.5],
  ];
  async function settings(content) {
    const { settings: s } = await api('GET', '/api/admin/settings');
    const inputs = {};
    const fields = SETTING_FIELDS.map(([k, label, mult, step]) => {
      inputs[k] = h('input', { type: 'number', min: 0, step, value: String(Math.round(s[k] * mult * 1000) / 1000) });
      return h('label', { class: 'field' }, h('span', null, label), inputs[k]);
    });
    clear(content).append(h('form', {
      class: 'panel stack',
      onSubmit: async (e) => {
        e.preventDefault();
        const body = {};
        for (const [k, , mult] of SETTING_FIELDS) body[k] = Number(inputs[k].value) / mult;
        try { await api('POST', '/api/admin/settings', body); toast('انحفظت الإعدادات'); } catch (ex) { toast(ex.message, true); }
      },
    }, h('p', { class: 'sub' }, 'الأجرة = رسوم الفتح + (سعر الكيلومتر × المسافة)، وما بتنزل عن الحد الأدنى. التغيير بيطبّق على الطلبات الجديدة بس.'),
    h('div', { class: 'form' }, fields), h('button', { class: 'btn sm', type: 'submit' }, 'حفظ')));
  }

  show();
})();
