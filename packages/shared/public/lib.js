/* Shared helpers for rider / driver / admin pages. Exposes window.RA */
(function () {
  'use strict';
  const RA = (window.RA = {});
  RA.AMMAN = { lat: 31.9539, lng: 35.9106 };

  /* DOM builder: h('div', {class:'x', onClick: fn}, child, 'text'). Text is never parsed as HTML. */
  RA.h = function (tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  RA.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /* localStorage that never throws */
  RA.store = {
    get(k) { try { return localStorage.getItem('ra_' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('ra_' + k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem('ra_' + k); } catch { /* ignore */ } },
  };

  let toastTimer;
  RA.toast = function (msg, isErr) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = RA.h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3800);
  };

  RA.jod = (n) => Number(n || 0).toFixed(2) + ' د.أ';
  RA.km = (n) => Number(n || 0).toFixed(1) + ' كم';

  RA.statusText = {
    requested: 'عم ندوّر على كابتن قريب...',
    accepted: 'الكابتن بالطريق إلك',
    arrived: 'الكابتن وصل لمكانك',
    in_progress: 'الرحلة شغّالة',
    completed: 'وصلت بالسلامة',
    cancelled: 'انلغت الرحلة',
    expired: 'ما لقينا كابتن متاح',
  };

  /* fetch wrapper that attaches the bearer token */
  RA.client = function (getToken, onUnauthorized) {
    return async function (method, path, body) {
      const token = getToken();
      let res;
      try {
        res = await fetch(path, {
          method,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw new Error('ما في اتصال بالسيرفر');
      }
      let data = {};
      try { data = await res.json(); } catch { /* empty */ }
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      if (!res.ok) throw new Error(data.error || 'صار خطأ');
      return data;
    };
  };

  /* Server-Sent Events (auto-reconnects). handlers: {eventName: fn(data)} */
  RA.events = function (token, handlers) {
    const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, (e) => {
        try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); }
      });
    }
    return es;
  };

  /* Leaflet helpers (Leaflet is loaded by the page) */
  RA.makeMap = function (elId, center, zoom) {
    const m = L.map(elId, { zoomControl: false }).setView([center.lat, center.lng], zoom || 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(m);
    return m;
  };
  RA.pin = (kind) => L.divIcon({ className: 'pin pin-' + kind, html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] });
  RA.carIcon = () => L.divIcon({ className: 'car', html: '🚕', iconSize: [30, 30], iconAnchor: [15, 15] });

  RA.locate = function () {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
      );
    });
  };

  /* Free-text place search (OpenStreetMap Nominatim, Jordan only). Fine for a pilot; use a paid geocoder at scale. */
  RA.search = async function (q) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=jo&accept-language=ar&q=' + encodeURIComponent(q);
    const res = await fetch(url);
    if (!res.ok) throw new Error('تعذّر البحث');
    const rows = await res.json();
    return rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), name: String(r.display_name).split(',').slice(0, 2).join('،').trim() }));
  };
  RA.reverse = async function (p) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=ar&lat=${p.lat}&lon=${p.lng}`);
      if (!res.ok) return null;
      const r = await res.json();
      return r && r.display_name ? String(r.display_name).split(',').slice(0, 2).join('،').trim() : null;
    } catch { return null; }
  };

  RA.beep = function () {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      RA._ac = RA._ac || new AC();
      const o = RA._ac.createOscillator(), g = RA._ac.createGain();
      o.connect(g); g.connect(RA._ac.destination);
      o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); o.stop(RA._ac.currentTime + 0.18);
    } catch { /* audio not available */ }
    if (navigator.vibrate) navigator.vibrate(200);
  };

  /* Login / register screen. role: 'rider' | 'driver'. onDone({token,user}) */
  RA.authView = function (role, onDone) {
    const h = RA.h;
    const isDriver = role === 'driver';
    let mode = 'login';
    const err = h('div', { class: 'err-text' });
    const inputs = {
      name: h('input', { autocomplete: 'name', maxlength: 60, placeholder: 'اسمك' }),
      phone: h('input', { type: 'tel', inputmode: 'tel', dir: 'ltr', autocomplete: 'tel', placeholder: '07xxxxxxxx' }),
      pin: h('input', { type: 'password', inputmode: 'numeric', dir: 'ltr', maxlength: 8, autocomplete: 'current-password', placeholder: '4 - 8 أرقام' }),
      car: h('input', { maxlength: 40, placeholder: 'مثال: Kia Picanto 2020' }),
      plate: h('input', { maxlength: 15, dir: 'ltr', placeholder: 'مثال: 10-12345' }),
    };
    const f = (label, key, extra) => h('label', { class: 'field' + (extra ? ' ' + extra : ''), 'data-k': key }, h('span', null, label), inputs[key]);
    const fields = [f('الاسم', 'name', 'reg'), f('رقم الهاتف', 'phone'), f('الرمز السري', 'pin')];
    if (isDriver) fields.push(f('نوع السيارة', 'car', 'reg'), f('رقم اللوحة', 'plate', 'reg'));
    const submit = h('button', { class: 'btn', type: 'submit' }, 'دخول');
    const tabLogin = h('button', { type: 'button', class: 'on', onClick: () => setMode('login') }, 'تسجيل دخول');
    const tabReg = h('button', { type: 'button', onClick: () => setMode('register') }, 'حساب جديد');

    function setMode(m) {
      mode = m;
      tabLogin.className = m === 'login' ? 'on' : '';
      tabReg.className = m === 'register' ? 'on' : '';
      fields.forEach((el) => { if (el.classList.contains('reg')) el.classList.toggle('hidden', m === 'login'); });
      submit.textContent = m === 'login' ? 'دخول' : 'إنشاء الحساب';
      inputs.pin.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      err.textContent = '';
    }

    const form = h('form', {
      class: 'stack',
      onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        try {
          const body = { role, phone: inputs.phone.value, pin: inputs.pin.value };
          if (mode === 'register') {
            body.name = inputs.name.value;
            if (isDriver) { body.car = inputs.car.value; body.plate = inputs.plate.value; }
          }
          const res = await RA.client(() => null)('POST', mode === 'login' ? '/api/login' : '/api/register', body);
          onDone(res);
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          submit.disabled = false;
        }
      },
    }, fields, err, submit);

    const wrap = h('div', { class: 'auth' },
      h('div', { class: 'logo' }, isDriver ? '🚕' : '📍'),
      h('h1', null, isDriver ? 'Volt كابتن' : 'Volt'),
      h('p', { class: 'sub' }, isDriver ? 'سجّل واشتغل على مواعيدك' : 'وين رايح؟ اطلب سيارة بدقيقة، والدفع كاش'),
      h('div', { class: 'tabs' }, tabLogin, tabReg),
      form);
    setMode('login');
    return wrap;
  };
})();
