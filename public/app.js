// Car Tracker front end: vanilla JS, no build step.
const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const state = { me: null, vehicles: [], rides: [], rideOffset: 0 };

const CARD = 'rounded-2xl bg-white p-4 shadow dark:bg-slate-800';
const INPUT = 'mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 dark:border-slate-600 dark:bg-slate-900';
const BTN = 'rounded-lg px-4 py-3 font-medium text-white disabled:opacity-40';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n, unit = '') => (n == null ? '—' : `${Number(n).toLocaleString()}${unit}`);
const money = (amount, cur) => (amount == null ? '—' : `${Number(amount).toFixed(2)} ${cur ?? ''}`.trim());
const notify = (err) => toast(err.message, false);

async function api(path, init = {}) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}
const sendJson = (method, path, data) => api(path, {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});
const sendForm = (path, fd) => api(path, { method: 'POST', body: fd });

function toast(msg, ok = true) {
  const el = document.createElement('div');
  el.className = `fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${ok ? 'bg-emerald-600' : 'bg-rose-600'}`;
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// Client-side resize + JPEG re-encode so uploads stay small for the low-power server.
async function shrink(file, maxSide = 1024, quality = 0.8) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement('canvas'), {
    width: Math.round(bitmap.width * scale),
    height: Math.round(bitmap.height * scale),
  });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Could not process image'))),
    'image/jpeg',
    quality,
  ));
}

function header(subtitle) {
  return `
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-slate-700 dark:bg-slate-800/90">
      <div class="mx-auto flex max-w-6xl items-center justify-between">
        <div>
          <div class="font-semibold">${esc(state.me.name)}</div>
          <div class="text-xs text-slate-500">${subtitle}</div>
        </div>
        <button data-logout class="text-sm font-medium text-indigo-600">Sign out</button>
      </div>
    </header>`;
}

// ---------- boot & login ----------
async function boot() {
  try {
    state.me = await api('/auth/me');
    state.vehicles = await api('/vehicles');
    if (state.me.role === 'admin') await renderAdmin();
    else renderDriver();
  } catch {
    renderLogin();
  }
}

function renderLogin(error = '') {
  app.innerHTML = `
    <main class="grid min-h-screen place-items-center p-4">
      <form id="login" class="${CARD} w-full max-w-sm space-y-4">
        <h1 class="text-xl font-semibold">Car Tracker</h1>
        <input name="email" type="email" required autocomplete="username" placeholder="Email" class="${INPUT}">
        <input name="password" type="password" required autocomplete="current-password" placeholder="Password" class="${INPUT}">
        <p class="min-h-5 text-sm text-rose-600">${esc(error)}</p>
        <button class="${BTN} w-full bg-indigo-600">Sign in</button>
      </form>
    </main>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await sendJson('POST', '/auth/login', Object.fromEntries(new FormData(e.target)));
      await boot();
    } catch (err) {
      renderLogin(err.message);
    }
  };
}

app.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-logout]')) return;
  await api('/auth/logout', { method: 'POST' });
  state.me = null;
  renderLogin();
});

// ---------- driver (mobile) ----------
const vehicleOptions = () => state.vehicles
  .map((v) => `<option value="${v.id}">${esc(v.name)}${v.plate ? ` · ${esc(v.plate)}` : ''}</option>`)
  .join('');

function renderDriver() {
  app.innerHTML = `
    ${header('Driver')}
    <main class="mx-auto max-w-md space-y-4 p-4">
      <label class="block text-sm font-medium">Vehicle
        <select id="vehicle" class="${INPUT}">${vehicleOptions()}</select>
      </label>

      <div class="grid grid-cols-2 gap-3">
        <button data-phase="before" class="${BTN} bg-emerald-600 py-6 text-left">📸<span class="mt-1 block font-semibold">Before ride</span></button>
        <button data-phase="after" id="after" class="${BTN} bg-sky-600 py-6 text-left">📸<span class="mt-1 block font-semibold">After ride</span></button>
      </div>
      <input id="camera" type="file" accept="image/*" capture="environment" class="hidden">
      <section id="verify"></section>

      <section class="${CARD} space-y-3">
        <h2 class="font-semibold">Service invoice</h2>
        <input id="invoice" type="file" accept="image/*" class="block w-full text-sm">
        <input id="inv-km" type="number" inputmode="numeric" placeholder="Odometer km (optional)" class="${INPUT} mt-0">
        <button id="inv-send" class="${BTN} w-full bg-slate-800">Upload invoice</button>
        <p id="inv-result" class="text-sm"></p>
      </section>

      <section class="space-y-2">
        <h2 class="font-semibold">Recent rides</h2>
        <div id="history" class="space-y-2"></div>
      </section>
    </main>`;

  let phase = null;
  const cam = $('#camera');
  document.querySelectorAll('[data-phase]').forEach((btn) => {
    btn.onclick = () => {
      phase = btn.dataset.phase;
      cam.click();
    };
  });
  cam.onchange = () => {
    const file = cam.files[0];
    cam.value = '';
    if (file) scanDashboard(file, phase);
  };
  $('#vehicle').onchange = updateAfterButton;
  $('#inv-send').onclick = sendInvoice;

  updateAfterButton();
  loadHistory().catch(notify);
}

function updateAfterButton() {
  const vehicle = state.vehicles.find((v) => v.id === Number($('#vehicle').value));
  $('#after').disabled = !vehicle?.open_ride_id;
  $('#after').title = vehicle?.open_ride_id ? '' : 'Take a Before-ride photo first';
}

async function refreshDriver() {
  state.vehicles = await api('/vehicles');
  updateAfterButton();
  await loadHistory();
}

async function scanDashboard(file, phase) {
  $('#verify').innerHTML = `<p class="${CARD} text-sm">Reading ${phase}-ride dashboard…</p>`;
  try {
    const fd = new FormData();
    fd.append('vehicle_id', $('#vehicle').value);
    fd.append('phase', phase);
    fd.append('image', await shrink(file), 'dashboard.jpg');
    const ride = await sendForm('/rides/scan', fd);
    renderVerify(ride, phase, ride.ai_error ? 'The photo could not be read automatically. Please enter the values.' : '');
    await refreshDriver();
  } catch (err) {
    $('#verify').innerHTML = '';
    notify(err);
  }
}

function renderVerify(ride, phase, notice = '') {
  const s = ride[phase];
  const diff = ride.mileage_difference;
  $('#verify').innerHTML = `
    <form id="verify-form" class="${CARD} space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">${phase === 'before' ? 'Before' : 'After'} ride check</h2>
        <span class="rounded-full px-2 py-1 text-xs ${s.source === 'ai' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-800'}">
          ${s.source === 'ai' ? 'AI read' : 'Enter manually'}</span>
      </div>
      ${notice ? `<p class="text-sm text-amber-700">${esc(notice)}</p>` : ''}
      ${s.photo ? `<img src="${esc(s.photo)}" alt="Dashboard photo" class="w-full rounded-lg">` : ''}
      <label class="block text-sm font-medium">Odometer (km)
        <input name="mileage" type="number" inputmode="numeric" value="${esc(s.mileage)}" class="${INPUT}"></label>
      <label class="block text-sm font-medium">Fuel (%)
        <input name="fuel_percentage" type="number" min="0" max="100" inputmode="numeric" value="${esc(s.fuel_percentage)}" class="${INPUT}"></label>
      <label class="block text-sm font-medium">Engine temperature
        <select name="engine_temp_status" class="${INPUT}">
          <option value="normal" ${s.engine_temp_status === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="high" ${s.engine_temp_status === 'high' ? 'selected' : ''}>High</option>
        </select></label>
      <label class="block text-sm font-medium">Warning lights <span class="font-normal text-slate-500">(comma separated)</span>
        <input name="warning_lights" value="${esc(s.warning_lights.join(', '))}" class="${INPUT}"></label>
      ${diff != null ? `<p class="text-sm">Distance this ride: <strong>${fmt(diff, ' km')}</strong></p>` : ''}
      ${ride.needs_review ? '<p class="text-sm text-amber-700">Please double-check these numbers.</p>' : ''}
      <button class="${BTN} w-full bg-indigo-600">Confirm ${phase} reading</button>
    </form>`;

  $('#verify-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const updated = await sendJson('PATCH', `/rides/${ride.id}`, {
        phase,
        mileage: f.get('mileage'),
        fuel_percentage: f.get('fuel_percentage'),
        engine_temp_status: f.get('engine_temp_status'),
        warning_lights: f.get('warning_lights').split(','),
      });
      renderVerify(updated, phase);
      toast('Saved');
      await loadHistory();
    } catch (err) {
      notify(err);
    }
  };
}

async function loadHistory() {
  const rides = await api('/rides?limit=10');
  $('#history').innerHTML = rides.map(rideCard).join('') || '<p class="text-sm text-slate-500">No rides yet.</p>';
}

function rideCard(r) {
  const when = new Date(`${r.started_at.replace(' ', 'T')}Z`).toLocaleDateString();
  return `
    <div class="${CARD} flex items-center justify-between text-sm">
      <div>
        <div class="font-medium">${esc(r.vehicle)} · ${when}</div>
        <div class="text-slate-500">${r.status === 'open' ? 'In progress' : 'Completed'}</div>
      </div>
      <div class="text-right">
        <div class="font-semibold">${fmt(r.mileage_difference, ' km')}</div>
        ${r.needs_review ? '<div class="text-xs text-amber-700">Needs review</div>' : ''}
      </div>
    </div>`;
}

async function sendInvoice() {
  const file = $('#invoice').files[0];
  const out = $('#inv-result');
  if (!file) return toast('Choose an invoice photo first', false);
  out.textContent = 'Reading invoice…';
  try {
    const fd = new FormData();
    fd.append('vehicle_id', $('#vehicle').value);
    // Larger than the 1024px dashboard limit so receipt text stays legible.
    fd.append('invoice', await shrink(file, 1600, 0.85), 'invoice.jpg');
    if ($('#inv-km').value) fd.append('odometer_km', $('#inv-km').value);
    const r = await sendForm('/maintenance', fd);
    const parts = [`Saved ${r.items.length} item(s)`];
    if (r.total_cost != null) parts.push(money(r.total_cost, r.currency));
    if (r.is_service) parts.push(`next service ${fmt(r.next_service_km, ' km')} or ${r.next_service_date}`);
    if (r.ai_error) parts.push('could not be read automatically; an admin will check it');
    out.textContent = `${parts.join(' · ')}.`;
    $('#invoice').value = '';
    await refreshDriver();
  } catch (err) {
    out.textContent = '';
    notify(err);
  }
}

// ---------- admin (desktop) ----------
const TH = 'p-3 font-medium';
const ROW = 'border-t border-slate-200 dark:border-slate-700';

async function renderAdmin() {
  app.innerHTML = `
    ${header('Administrator')}
    <main class="mx-auto max-w-6xl space-y-8 p-4 md:p-8">
      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Vehicles</h2>
        <div id="vehicles" class="grid gap-4 md:grid-cols-3"></div>
        <form id="add-vehicle" class="${CARD} flex flex-wrap gap-2">
          <input name="name" required placeholder="Vehicle name" class="${INPUT} mt-0 flex-1">
          <input name="plate" placeholder="Plate" class="${INPUT} mt-0 w-32">
          <button class="${BTN} bg-indigo-600">Add vehicle</button>
        </form>
      </section>

      <section class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-lg font-semibold">Ride log</h2>
          <select id="ride-vehicle" class="${INPUT} mt-0 w-auto"></select>
        </div>
        <div class="${CARD} overflow-x-auto p-0">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900">
              <tr><th class="${TH}">Date</th><th>Vehicle</th><th>Driver</th><th>Before</th><th>After</th>
                  <th>Driven</th><th>Fuel</th><th>Engine</th><th>Warnings</th><th>Photos</th></tr>
            </thead>
            <tbody id="ride-rows"></tbody>
          </table>
        </div>
        <button id="more" class="text-sm font-medium text-indigo-600">Load more</button>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">Maintenance</h2>
        <div class="${CARD} overflow-x-auto p-0">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900">
              <tr><th class="${TH}">Service date</th><th>Vehicle</th><th>Driver</th><th>Odometer</th>
                  <th>Total</th><th>Items</th><th>Invoice</th></tr>
            </thead>
            <tbody id="maint-rows"></tbody>
          </table>
        </div>
      </section>

      <section class="grid gap-8 md:grid-cols-2">
        <div class="space-y-3">
          <h2 class="text-lg font-semibold">Drivers</h2>
          <ul id="drivers" class="space-y-2"></ul>
          <form id="add-driver" class="${CARD} grid gap-2">
            <input name="name" required placeholder="Name" class="${INPUT} mt-0">
            <input name="email" type="email" required placeholder="Email" class="${INPUT} mt-0">
            <input name="password" type="password" required minlength="8" placeholder="Temporary password (8+ characters)" class="${INPUT} mt-0">
            <button class="${BTN} bg-indigo-600">Add driver</button>
          </form>
        </div>
        <div class="space-y-3">
          <h2 class="text-lg font-semibold">Calendar feed</h2>
          <p class="text-sm text-slate-500">In Google or Apple Calendar, add a calendar “from URL” and paste this link.</p>
          <div class="${CARD} space-y-3">
            <input id="cal-url" readonly class="${INPUT} mt-0 text-sm">
            <div class="flex gap-2">
              <button id="cal-copy" class="${BTN} bg-slate-800">Copy</button>
              <button id="cal-rotate" class="${BTN} bg-rose-600">Rotate link</button>
            </div>
          </div>
        </div>
      </section>
    </main>`;

  bindAdmin();
  await loadVehicles();
  await Promise.all([loadRides(true), loadMaintenance(), loadDrivers(), loadCalendar()]);
}

function bindAdmin() {
  $('#ride-vehicle').onchange = () => loadRides(true).catch(notify);
  $('#more').onclick = () => loadRides().catch(notify);
  $('#add-vehicle').onsubmit = (e) => submitForm(e,
    () => sendJson('POST', '/admin/vehicles', Object.fromEntries(new FormData(e.target))), loadVehicles);
  $('#add-driver').onsubmit = (e) => submitForm(e,
    () => sendJson('POST', '/admin/users', Object.fromEntries(new FormData(e.target))), loadDrivers);
  $('#drivers').onclick = async (e) => {
    const id = e.target.dataset.remove;
    if (!id || !confirm('Remove this driver? Their past rides and invoices are kept.')) return;
    try {
      await api(`/admin/users/${id}`, { method: 'DELETE' });
      await loadDrivers();
    } catch (err) {
      notify(err);
    }
  };
  $('#cal-copy').onclick = () => navigator.clipboard.writeText($('#cal-url').value).then(() => toast('Link copied'));
  $('#cal-rotate').onclick = async () => {
    if (!confirm('Existing calendar subscriptions will stop working. Continue?')) return;
    $('#cal-url').value = (await sendJson('POST', '/admin/calendar/rotate', {})).url;
  };
}

async function submitForm(e, action, afterSave) {
  e.preventDefault();
  try {
    await action();
    e.target.reset();
    toast('Saved');
    await afterSave();
  } catch (err) {
    notify(err);
  }
}

async function loadVehicles() {
  const vehicles = await api('/admin/overview');
  $('#vehicles').innerHTML = vehicles.map((v) => `
    <div class="${CARD}">
      <div class="flex items-start justify-between">
        <h3 class="font-semibold">${esc(v.name)}</h3>
        <span class="text-xs text-slate-500">${esc(v.plate ?? '')}</span>
      </div>
      <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm">
        <dt class="text-slate-500">Odometer</dt><dd>${fmt(v.odometer_km, ' km')}</dd>
        <dt class="text-slate-500">Next service</dt><dd>${fmt(v.next_service_km, ' km')}${v.next_service_date ? `<br>${esc(v.next_service_date)}` : ''}</dd>
        <dt class="text-slate-500">Rides (30 days)</dt><dd>${v.rides_30d}</dd>
        <dt class="text-slate-500">Distance (30 days)</dt><dd>${fmt(v.km_30d, ' km')}</dd>
      </dl>
    </div>`).join('') || `<p class="text-sm text-slate-500">No vehicles yet.</p>`;

  const current = $('#ride-vehicle').value;
  $('#ride-vehicle').innerHTML = '<option value="">All vehicles</option>'
    + vehicles.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  $('#ride-vehicle').value = current;
}

async function loadRides(reset = false) {
  if (reset) {
    state.rides = [];
    state.rideOffset = 0;
  }
  const vehicle = $('#ride-vehicle').value;
  const page = await api(`/rides?limit=25&offset=${state.rideOffset}${vehicle ? `&vehicle_id=${vehicle}` : ''}`);
  state.rides.push(...page);
  state.rideOffset += page.length;
  $('#ride-rows').innerHTML = state.rides.map(rideRow).join('')
    || '<tr><td colspan="10" class="p-4 text-slate-500">No rides yet.</td></tr>';
  $('#more').hidden = page.length < 25;
}

function rideRow(r) {
  const { before: b, after: a } = r;
  const link = (s, label) => (s?.photo ? `<a class="text-indigo-600 underline" href="${esc(s.photo)}" target="_blank" rel="noopener">${label}</a>` : '');
  const warnings = [...new Set([...(b?.warning_lights ?? []), ...(a?.warning_lights ?? [])])];
  const hot = b?.engine_temp_status === 'high' || a?.engine_temp_status === 'high';
  return `
    <tr class="${ROW} ${r.needs_review ? 'bg-amber-50 dark:bg-amber-950/40' : ''}">
      <td class="whitespace-nowrap p-3">${esc(new Date(`${r.started_at.replace(' ', 'T')}Z`).toLocaleString())}</td>
      <td>${esc(r.vehicle)}</td>
      <td>${esc(r.driver)}</td>
      <td>${fmt(b?.mileage)}</td>
      <td>${fmt(a?.mileage)}</td>
      <td class="font-semibold">${fmt(r.mileage_difference, ' km')}</td>
      <td>${fmt(a?.fuel_percentage ?? b?.fuel_percentage, '%')}</td>
      <td>${hot ? '<span class="font-semibold text-rose-600">High</span>' : 'Normal'}</td>
      <td>${warnings.length ? esc(warnings.join(', ')) : '—'}</td>
      <td class="space-x-2">${link(b, 'Before')}${link(a, 'After')}</td>
    </tr>`;
}

async function loadMaintenance() {
  const rows = await api('/maintenance');
  $('#maint-rows').innerHTML = rows.map((m) => `
    <tr class="${ROW}">
      <td class="p-3">${esc(m.service_date ?? '—')}</td>
      <td>${esc(m.vehicle)}</td>
      <td>${esc(m.driver)}</td>
      <td>${fmt(m.odometer_km, ' km')}</td>
      <td>${money(m.total_cost_cents == null ? null : m.total_cost_cents / 100, m.currency)}</td>
      <td>${m.items.map((i) => esc(i.description)).join(', ') || '—'}</td>
      <td><a class="text-indigo-600 underline" href="${esc(m.invoice)}" target="_blank" rel="noopener">View</a></td>
    </tr>`).join('')
    || '<tr><td colspan="7" class="p-4 text-slate-500">No invoices yet.</td></tr>';
}

async function loadDrivers() {
  const users = await api('/admin/users');
  $('#drivers').innerHTML = users.map((u) => `
    <li class="${CARD} flex items-center justify-between py-3">
      <div>
        <div class="font-medium">${esc(u.name)}</div>
        <div class="text-xs text-slate-500">${esc(u.email)} · ${esc(u.role)}</div>
      </div>
      ${u.role === 'driver' ? `<button data-remove="${u.id}" class="text-sm font-medium text-rose-600">Remove</button>` : ''}
    </li>`).join('');
}

async function loadCalendar() {
  $('#cal-url').value = (await api('/admin/calendar')).url;
}

boot();
