import { renderExtras } from './extras.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const labels = {
  overview: 'ภาพรวมสถานการณ์',
  patients: 'รายชื่อผู้ป่วย',
  zones: 'พื้นที่ปฏิบัติงาน & Decon',
  stock: 'คลังเวชภัณฑ์',
  erg: 'คู่มือ ERG4Thai',
  cards: 'พริ้นต์การ์ด QR',
};
const mobileLabels = {
  overview: 'ภาพรวม',
  patients: 'ผู้ป่วย',
  zones: 'พื้นที่',
  stock: 'เวชภัณฑ์',
  erg: 'สารเคมี',
  cards: 'การ์ด QR',
};
const zoneLabels = {
  triage: 'จุดคัดแยก',
  decon: 'จุดชำระล้าง',
  treatment: 'จุดรักษา',
  staging: 'จุดรอส่งต่อ',
  evacuated: 'ส่งต่อแล้ว',
  discharged: 'จำหน่ายแล้ว',
  morgue: 'จุดพักศพ',
};
const colorLabels = { red: 'แดง', yellow: 'เหลือง', green: 'เขียว', black: 'ดำ' };
const points = { primary: 'Primary', secondary: 'Secondary' };
const deconLabels = {
  pending: 'รอชำระล้าง',
  'in-progress': 'กำลังชำระล้าง',
  cleared: 'ชำระล้างแล้ว',
};
const interventions = [
  'O2 / Airway',
  'ETT',
  'Needle Decomp / ICD',
  'Stop Bleeding',
  'IV Fluid',
  'Decontamination',
  'Splint / C-Collar',
  'CPR',
];
const state = {
  session: null,
  incident: null,
  incidents: [],
  overview: { patients: [], stock: [], staffCount: 0 },
  sheetSync: null,
  activePage: 'overview',
  selectedPatient: null,
  history: [],
  filterQuery: '',
  filterColor: '',
  filterZone: '',
  filterTriage: '',
  chartRequest: 0,
  requestId: '',
  presenceTimer: null,
};

export async function api(path, options = {}) {
  const init = {
    credentials: 'same-origin',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(state.incident?.id ? { 'X-Incident-ID': state.incident.id } : {}),
      ...(options.headers || {}),
    },
  };
  if (options.body && typeof options.body !== 'string') {
    init.body = JSON.stringify(options.body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    /* empty response */
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error || `Request failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function refresh() {
  const incidentId = state.incident?.id;
  const accountId = state.session?.id;
  if (!incidentId || !accountId) return;
  try {
    const overview = await api('/api/overview');
    if (state.incident?.id !== incidentId || state.session?.id !== accountId)
      return;
    state.overview = overview;
    if (overview.incident) {
      state.incident = overview.incident;
      state.incidents = state.incidents.map((item) =>
        item.id === incidentId ? overview.incident : item,
      );
    }
  } catch (error) {
    notify(error.message, 'error');
    return;
  }
  renderIncidentBar();
  renderCorePage();
  if (state.activePage === 'stock') renderExtraPage('stock');
}

function text(value, fallback = '—') {
  return value === undefined || value === null || value === ''
    ? fallback
    : String(value);
}
function fmtDate(value) {
  if (!value) return 'ยังไม่มีข้อมูล';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? text(value)
    : date.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function button(label, className, handler) {
  const b = el('button', `btn ${className}`, label);
  b.type = 'button';
  b.addEventListener('click', handler);
  return b;
}
function badge(color) {
  return el(
    'span',
    `badge badge-${color || 'black'}`,
    colorLabels[color] || text(color),
  );
}
function patientIdFromUrl() {
  return new URLSearchParams(location.search).get('id') || '';
}
function notify(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}
function showError(target, message) {
  target.textContent = message;
  target.hidden = !message;
}

function renderNav() {
  const make = (mobile = false) =>
    Object.entries(labels).map(([page, label]) => {
      const b = el(
        'button',
        `nav-item ${state.activePage === page ? 'active' : ''}`,
        mobile ? mobileLabels[page] : label,
      );
      b.type = 'button';
      if (state.activePage === page) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => navigate(page));
      if (mobile) b.setAttribute('aria-label', label);
      return b;
    });
  $('#sideNav').replaceChildren(...make());
  $('#mobileNav').replaceChildren(...make(true));
}
function navigate(page) {
  state.activePage = page;
  window.scrollTo(0, 0);
  renderNav();
  $$('.page-section').forEach((s) => {
    s.hidden = s.dataset.page !== page;
  });
  renderCorePage();
  if (['stock', 'erg', 'cards'].includes(page)) renderExtraPage(page);
}
function renderExtraPage(page) {
  const incident = state.incident;
  renderExtras(page, {
    root: $(`#page-${page}`),
    state: state.overview,
    api: (path, options = {}) =>
      api(path, {
        ...options,
        headers: {
          ...options.headers,
          'X-Incident-ID': incident?.id || 'legacy',
        },
      }),
    notify,
    incidentId: incident?.id || 'legacy',
    incidentName: incident?.name,
    incidentClosed: Boolean(incident?.closedAt),
  });
}

function renderCorePage() {
  if (!state.session) return;
  const fn = {
    overview: renderOverview,
    patients: renderPatients,
    zones: renderZones,
  }[state.activePage];
  if (fn) fn($(`#page-${state.activePage}`));
}
function renderIncidentBar() {
  const root = $('#incidentBar');
  if (!root || !state.session) return;
  root.replaceChildren();
  const select = document.createElement('select');
  select.id = 'incidentSelect';
  select.setAttribute('aria-label', 'เลือกเหตุการณ์');
  state.incidents.forEach((incident) =>
    select.append(
      new Option(
        `${incident.name}${incident.closedAt ? ' (ปิดแล้ว)' : ''}`,
        incident.id,
      ),
    ),
  );
  const placeholder = new Option('เลือกเหตุการณ์…', '');
  placeholder.disabled = true;
  select.prepend(placeholder);
  select.value = state.incident?.id || '';
  select.addEventListener('change', () => {
    const next = state.incidents.find((x) => x.id === select.value);
    if (next) selectIncident(next);
  });
  const create = el('input');
  create.placeholder = 'ชื่อเหตุการณ์ใหม่';
  create.setAttribute('aria-label', 'ชื่อเหตุการณ์ใหม่');
  create.maxLength = 120;
  create.id = 'incidentName';
  const add = button('สร้างเหตุการณ์', 'btn-secondary btn-sm', async () => {
    const name = create.value.trim();
    if (!name) {
      create.focus();
      return;
    }
    add.disabled = true;
    try {
      const result = await api('/api/incidents', {
        method: 'POST',
        body: { name },
      });
      await loadIncidents();
      selectIncident(result.incident);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      add.disabled = false;
    }
  });
  const close =
    state.incident && !state.incident.closedAt
      ? button('ปิดเหตุการณ์', 'btn-danger btn-sm', async () => {
          const selected = state.incident;
          if (
            !window.confirm(
              `ปิดเหตุการณ์ “${selected.name}” และเก็บไว้ดูย้อนหลังหรือไม่?`,
            )
          )
            return;
          close.disabled = true;
          try {
            const result = await api(
              `/api/incidents/${encodeURIComponent(selected.id)}`,
              { method: 'PATCH', body: { closed: true } },
            );
            await loadIncidents();
            if (state.incident?.id === selected.id)
              selectIncident(result.incident);
            else renderIncidentBar();
          } catch (error) {
            notify(error.message, 'error');
          } finally {
            close.disabled = false;
          }
        })
      : null;
  const current = el('div', 'incident-current');
  current.append(el('strong', null, 'เหตุการณ์'), select);
  if (close) current.append(close);
  const actions = el('div', 'incident-create');
  actions.append(create, add);
  root.append(current, actions);
}
async function loadIncidents() {
  const data = await api('/api/incidents');
  state.incidents = data.incidents || [];
}
async function selectIncident(incident, { preserveQr = false } = {}) {
  const modal = $('#patientDialog');
  if (modal.open) modal.close();
  if (!preserveQr && patientIdFromUrl())
    window.history.replaceState(null, '', location.pathname);
  state.incident = incident;
  state.overview = { patients: [], stock: [] };
  state.filterQuery =
    state.filterColor =
    state.filterZone =
    state.filterTriage =
      '';
  sessionStorage.setItem('thaisim-incident', incident.id);
  renderIncidentBar();
  if (state.activePage === 'cards') renderExtraPage('cards');
  else if (state.activePage === 'stock') renderExtraPage('stock');
  else renderCorePage();
  await refresh();
  sendPresence();
}
function pageHead(title, subtitle, action) {
  const head = el('div', 'page-head');
  const copy = el('div');
  copy.append(el('h1', null, title), el('p', 'muted', subtitle));
  head.append(copy);
  if (action) head.append(action);
  return head;
}
function renderOverview(root) {
  const patients = state.overview.patients || [];
  const counts = Object.fromEntries(
    Object.keys(colorLabels).map((k) => [
      k,
      patients.filter((p) => p.color === k).length,
    ]),
  );
  const active = patients.filter(
    (p) => !['evacuated', 'discharged', 'morgue'].includes(p.zone),
  ).length;
  const kpis = [
    ['ผู้ป่วยทั้งหมด', patients.length],
    ['อยู่ระหว่างดูแล', active],
    ['จุดชำระล้าง', patients.filter((p) => p.zone === 'decon').length],
    ['ส่งต่อแล้ว', patients.filter((p) => p.zone === 'evacuated').length],
    ['จำหน่ายแล้ว', patients.filter((p) => p.zone === 'discharged').length],
    ['จุดพักศพ', patients.filter((p) => p.zone === 'morgue').length],
  ];
  const grid = el('div', 'kpi-grid');
  kpis.forEach(([label, value]) => {
    const card = el('article', 'kpi');
    card.append(
      el('span', 'kpi-label', label),
      el('strong', 'kpi-value', String(value)),
    );
    grid.append(card);
  });
  const colorPanel = el('section', 'panel');
  colorPanel.append(el('h2', 'panel-head', 'แยกตามสีคัดแยก'));
  const bars = el('div', 'bar-list');
  Object.entries(colorLabels).forEach(([key, label]) => {
    const row = el('div', 'bar-row');
    const meta = el('div', 'bar-meta');
    meta.append(
      el('span', null, label),
      el('strong', null, String(counts[key])),
    );
    const track = el('div', 'bar-track');
    const fill = el('div', `bar-fill fill-${key}`);
    fill.style.width = `${patients.length ? (counts[key] / patients.length) * 100 : 0}%`;
    track.append(fill);
    row.append(meta, track);
    bars.append(row);
  });
  colorPanel.append(bars);
  const zonePanel = el('section', 'panel');
  zonePanel.append(el('h2', 'panel-head', 'แยกตามพื้นที่'));
  const zoneList = el('div', 'summary-list');
  Object.entries(zoneLabels).forEach(([zone, label]) => {
    const count = patients.filter((p) => p.zone === zone).length;
    const row = el('button', 'summary-row');
    row.append(
      el('span', null, label),
      el('strong', 'summary-count', String(count)),
    );
    row.setAttribute('aria-label', `${label} ${count} เคส`);
    row.type = 'button';
    row.addEventListener('click', () => {
      state.filterQuery = '';
      state.filterColor = '';
      state.filterTriage = '';
      state.filterZone = zone;
      navigate('patients');
    });
    zoneList.append(row);
  });
  zonePanel.append(zoneList);
  const lowStock = state.overview.stock.filter(
    (item) => item.qty <= item.minAlert,
  ).length;
  const stats = el('div', 'operation-stats');
  stats.append(
    Object.assign(
      el(
        'span',
        'badge staff-online',
        `เจ้าหน้าที่ออนไลน์ ${state.overview.onlineStaffCount || 0} คน`,
      ),
      { id: 'onlineCount' },
    ),
    button(`เวชภัณฑ์ใกล้หมด ${lowStock} รายการ`, 'btn-secondary btn-sm', () =>
      navigate('stock'),
    ),
  );
  zonePanel.append(stats);
  const recent = el('section', 'panel');
  const rh = el('div', 'panel-head');
  rh.append(el('h2', null, 'รายการอัปเดตล่าสุด'));
  rh.append(
    button('ดูผู้ป่วยทั้งหมด', 'btn-secondary btn-sm', () => navigate('patients')),
  );
  recent.append(
    rh,
    patientTable(
      patients
        .slice()
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, 8),
    ),
  );
  const overviewGrid = el('div', 'overview-grid');
  overviewGrid.append(colorPanel, zonePanel);
  const review = state.overview.triageReview;
  const reviewPanel = el('section', 'panel triage-review');
  reviewPanel.append(el('h2', 'panel-head', 'ทบทวนการคัดแยก'));
  if (review) {
    renderTriageReview(reviewPanel, review);
  } else reviewPanel.append(el('p', 'muted', 'ยังไม่มีข้อมูลทบทวนการคัดแยก'));
  const heading = pageHead(
    'ภาพรวมสถานการณ์',
    `${state.incident?.name || 'เลือกเหตุการณ์'} · ${state.session.name} · ${state.session.org}`,
    state.incident && !state.incident.closedAt
      ? button('+ บันทึกเคสใหม่', 'btn-primary', () => openPatient())
      : null,
  );
  heading.classList.add('overview-heading');
  root.replaceChildren(
    heading,
    grid,
    overviewGrid,
    reviewPanel,
    recent,
    renderSheetPanel(),
  );
}

function renderSheetPanel() {
  const panel = el('section', 'panel sheet-dashboard');
  const content = el('div');
  const lastSync = state.sheetSync?.lastSyncedAt;
  content.append(
    el('h2', null, 'Google Sheets'),
    el(
      'p',
      null,
      lastSync ? `ซิงก์ล่าสุด ${fmtDate(lastSync)}` : 'รอเปิดการซิงก์ผู้ป่วยและเจ้าหน้าที่',
    ),
  );
  panel.append(content);
  if (state.sheetSync?.sheetUrl) {
    const link = el('a', 'btn btn-secondary btn-sm', 'เปิดชีตจัดการข้อมูล');
    link.href = state.sheetSync.sheetUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    panel.append(link);
  }
  return panel;
}

function renderTriageReview(panel, review) {
  const coverage =
    review.coveragePercent == null ? '—' : `${review.coveragePercent}%`;
  const summary = el('dl', 'triage-review-summary');
  for (const [label, amount] of [
    ['คู่ Primary → Secondary', review.matchedCases],
    ['ความครอบคลุมจาก Primary', coverage],
    ['Secondary เร่งด่วนขึ้น', review.higherDirection],
    ['Secondary เร่งด่วนน้อยลง', review.lowerDirection],
    ['สีเดิม', review.unchanged],
    ['คู่ที่มีสีดำ', review.blackCases],
  ]) {
    const item = el('div');
    item.append(el('dt', null, label), el('dd', null, String(amount ?? '—')));
    summary.append(item);
  }
  panel.append(summary);
  panel.append(
    el(
      'p',
      'muted',
      `มีข้อมูล Primary ${review.primaryCases ?? 0} เคส · ยังไม่มี Secondary ที่จับคู่ได้ ${review.withoutSecondary ?? 0} เคส`,
    ),
  );
  panel.append(
    el('p', 'muted', 'ใช้ความต่างของสีเป็นจุดตั้งต้นให้ทีมทบทวนเหตุผลหลังการฝึกซ้อม'),
  );
  if (!review.changes?.length) return;
  const changes = el('details', 'triage-changes');
  changes.append(
    el('summary', null, `ดูเคสที่สีเปลี่ยน ${review.changes.length} เคส`),
  );
  const list = el('ul');
  for (const change of review.changes) {
    const item = el('li');
    item.append(
      button(change.id, 'btn-secondary btn-sm', () => openPatient(change.id)),
      badge(change.primary),
      el('span', null, '→'),
      badge(change.secondary),
    );
    list.append(item);
  }
  changes.append(list);
  panel.append(changes);
}
function patientTable(patients) {
  const wrap = el('div', 'table-wrap patient-table');
  const table = el('table');
  const head = el('thead');
  const tr = el('tr');
  [
    'รหัส',
    'สี',
    'พื้นที่ / จุดคัดแยก',
    'Decon',
    'อาการหลัก',
    'Vital signs',
    'อัปเดต',
    '',
  ].forEach((h) => tr.append(el('th', null, h)));
  head.append(tr);
  const body = el('tbody');
  if (!patients.length) {
    const row = el('tr');
    const cell = el('td', 'empty', 'ยังไม่มีผู้ป่วย');
    cell.colSpan = 8;
    row.append(cell);
    body.append(row);
  }
  patients.forEach((p) => {
    const row = el('tr');
    const codeCell = el('td', 'patient-code');
    const openByCode = button(text(p.id), 'patient-code-link', () =>
      openPatient(p.id),
    );
    openByCode.setAttribute('aria-label', `เปิดแฟ้ม ${p.id}`);
    codeCell.append(openByCode);
    row.append(
      codeCell,
      tdBadge(p.color),
      el(
        'td',
        null,
        `${zoneLabels[p.zone] || text(p.zone)}${points[p.triagePoint] ? ` · ${points[p.triagePoint]}` : ''}`,
      ),
      el('td', null, deconLabels[p.deconStatus] || '—'),
      el('td', null, text(p.cc)),
      el('td', null, vitalText(p)),
      el('td', null, fmtDate(p.updatedAt)),
    );
    const actions = el('td');
    actions.append(
      button('เปิด', 'btn-secondary btn-sm', () => openPatient(p.id)),
    );
    row.append(actions);
    body.append(row);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
function tdBadge(color) {
  const td = el('td');
  td.append(badge(color));
  return td;
}
function vitalText(p) {
  return (
    [
      p.rr && `RR ${p.rr}`,
      p.hr && `HR ${p.hr}`,
      p.bp && `BP ${p.bp}`,
      p.spo2 && `SpO₂ ${p.spo2}`,
      p.gcs && `GCS ${p.gcs}`,
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

function renderPatients(root) {
  const q = state.filterQuery || '';
  const color = state.filterColor || '';
  const zone = state.filterZone || '';
  const triage = state.filterTriage || '';
  const search = el('input');
  search.id = 'patientSearch';
  search.type = 'search';
  search.placeholder = 'ค้นหารหัส อาการ หรือโรงพยาบาลปลายทาง';
  search.setAttribute('aria-label', 'ค้นหาผู้ป่วย');
  search.value = q;
  search.addEventListener('input', () => {
    state.filterQuery = search.value;
    updateResults();
  });
  const colorSelect = el('select');
  colorSelect.setAttribute('aria-label', 'กรองตามสีคัดแยก');
  [['', 'ทุกสี Triage'], ...Object.entries(colorLabels)].forEach(
    ([value, label]) => colorSelect.append(new Option(label, value)),
  );
  colorSelect.value = color;
  colorSelect.addEventListener('change', () => {
    state.filterColor = colorSelect.value;
    updateResults();
  });
  const zoneSelect = el('select');
  zoneSelect.setAttribute('aria-label', 'กรองตามพื้นที่');
  [['', 'ทุก Zone'], ...Object.entries(zoneLabels)].forEach(([value, label]) =>
    zoneSelect.append(new Option(label, value)),
  );
  zoneSelect.value = zone;
  zoneSelect.addEventListener('change', () => {
    state.filterZone = zoneSelect.value;
    updateResults();
  });
  const triageSelect = el('select');
  triageSelect.setAttribute('aria-label', 'กรองตามจุดคัดแยก');
  [
    ['', 'ทุกจุดคัดแยก'],
    ['primary', 'Primary Triage'],
    ['secondary', 'Secondary Triage'],
  ].forEach(([value, label]) => triageSelect.append(new Option(label, value)));
  triageSelect.value = triage;
  triageSelect.addEventListener('change', () => {
    state.filterTriage = triageSelect.value;
    updateResults();
  });
  const resultCount = el('span', 'result-count');
  const results = el('div');
  function updateResults() {
    const term = state.filterQuery.trim().toLowerCase();
    const list = state.overview.patients.filter(
      (p) =>
        (!term ||
          [p.id, p.cc, p.demo, p.transport, zoneLabels[p.zone]]
            .join(' ')
            .toLowerCase()
            .includes(term)) &&
        (!state.filterColor || p.color === state.filterColor) &&
        (!state.filterZone || p.zone === state.filterZone) &&
        (!state.filterTriage || p.triagePoint === state.filterTriage),
    );
    resultCount.textContent = `${list.length} รายการ`;
    results.replaceChildren(patientTable(list));
  }
  const filter = el('div', 'filters');
  filter.append(search, colorSelect, zoneSelect, triageSelect, resultCount);
  const actions = el('div', 'page-actions');
  if (!state.incident?.closedAt)
    actions.append(button('+ เพิ่มผู้ป่วยใหม่', 'btn-primary', () => openPatient()));
  root.replaceChildren(
    pageHead('รายชื่อผู้ป่วย', 'เปิดแฟ้มเพื่อดูประวัติย้อนหลังและบันทึกการเปลี่ยนแปลง', actions),
    el('section', 'panel'),
  );
  root.lastElementChild.append(filter, results);
  updateResults();
}

function renderZones(root) {
  const patients = state.overview.patients || [];
  const grid = el('div', 'zone-grid');
  const stations = [
    ['triage', 'คัดแยกเบื้องต้น (Primary)', 'primary'],
    ['triage', 'คัดแยกซ้ำ (Secondary)', 'secondary'],
    ['triage', 'คัดแยก (ทุกจุด)', ''],
    ...Object.entries(zoneLabels).filter(([zone]) => zone !== 'triage'),
  ];
  stations.forEach(([zone, label, point = '']) => {
    const list = patients.filter(
      (p) => p.zone === zone && (!point || p.triagePoint === point),
    );
    const card = el('button', 'zone-card');
    card.type = 'button';
    card.append(
      el('strong', 'zone-title', label),
      el('span', 'zone-total', `${list.length} เคส`),
    );
    card.append(
      el(
        'small',
        null,
        list.length ? list.map((p) => p.id).join(' · ') : 'ยังไม่มีผู้ป่วย',
      ),
    );
    if (zone === 'decon' && list.length) {
      const status = el('div', 'zone-status');
      for (const [value, caption] of Object.entries(deconLabels)) {
        const count = list.filter((p) => p.deconStatus === value).length;
        if (count) status.append(el('span', 'badge', `${caption} ${count}`));
      }
      card.append(status);
    }
    card.addEventListener('click', () => {
      state.filterQuery = '';
      state.filterColor = '';
      state.filterTriage = point;
      state.filterZone = zone;
      navigate('patients');
    });
    grid.append(card);
  });
  root.replaceChildren(
    pageHead(
      'พื้นที่ปฏิบัติงาน & Decon',
      'คลิกพื้นที่เพื่อดูรายชื่อผู้ป่วยในโซนนั้น',
      state.incident?.closedAt
        ? null
        : button('+ บันทึก / ย้ายโซน', 'btn-primary', () => openPatient()),
    ),
    grid,
  );
}

function clearForm() {
  $('#patientForm').reset();
  $('#patientColor').value = '';
  $$('.triage-option').forEach((b) => b.classList.remove('selected'));
  $$('#interventionPicker input').forEach((i) => {
    i.checked = false;
  });
  showError($('#patientError'), '');
  renderStockUsage();
}
function renderStockUsage() {
  const root = $('#stockUsagePicker');
  if (!root) return;
  root.replaceChildren();
  $('#stockUsageDetails').open = false;
  $('#stockUsageDetails').hidden = Boolean(state.incident?.closedAt);
  (state.overview.stock || []).forEach((item) => {
    const label = el(
      'label',
      null,
      `${item.name} · เหลือ ${item.qty} ${item.unit || ''}`,
    );
    const input = el('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(item.qty);
    input.step = '1';
    input.placeholder = '0';
    input.dataset.stockId = item.id;
    input.setAttribute('aria-label', `ใช้ ${item.name}`);
    label.append(input);
    root.append(label);
  });
}
function openPatient(id = '') {
  if (!state.incident || (state.incident.closedAt && !id)) return;
  clearForm();
  const chartRequest = ++state.chartRequest;
  state.selectedPatient = null;
  state.history = [];
  state.requestId =
    globalThis.crypto?.randomUUID?.() ||
    `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  $('#dialogTitle').textContent = id ? `แฟ้ม ${id}` : 'บันทึกผู้ป่วย';
  $('#historyPanel').hidden = true;
  $('#stockHistory').hidden = true;
  $('#patientIdHelp').hidden = Boolean(id);
  $('#patientId').readOnly = Boolean(id);
  $('#patientId').value = id;
  $('#savePatientBtn').disabled = Boolean(id);
  if (state.incident?.closedAt) $('#savePatientBtn').disabled = true;
  $('#dialogMeta').textContent = id
    ? 'กำลังโหลดข้อมูล…'
    : 'กรอกสี Triage และข้อมูลที่ทราบ';
  $('#patientDialog').showModal();
  if (id) loadPatient(id, chartRequest);
}
async function loadPatient(id, chartRequest) {
  const stillOpen = () =>
    $('#patientDialog').open && state.chartRequest === chartRequest;
  try {
    const data = await api(`/api/patients/${encodeURIComponent(id)}`);
    if (!stillOpen()) return;
    if (!data.patient) {
      $('#dialogTitle').textContent = state.incident?.closedAt
        ? `แฟ้ม ${id}`
        : `ขึ้นทะเบียน ${id}`;
      $('#dialogMeta').textContent = state.incident?.closedAt
        ? 'ไม่มีแฟ้มรหัสนี้ในเหตุการณ์ที่ปิดแล้ว'
        : 'กรอกข้อมูลเพื่อสร้างแฟ้มใหม่สำหรับการ์ดนี้';
      $('#savePatientBtn').disabled = Boolean(state.incident?.closedAt);
      return;
    }
    state.selectedPatient = data.patient;
    fillPatient(data.patient);
    state.history = data.history || [];
    $('#historyPanel').hidden = false;
    renderHistory();
    renderStockHistory(data.stockMovements || []);
    $('#dialogMeta').textContent =
      `แก้ไขล่าสุด ${fmtDate(data.patient.updatedAt)}`;
    $('#savePatientBtn').disabled = Boolean(
      state.incident?.closedAt || data.patient.deletedAt,
    );
    if (data.patient.deletedAt)
      $('#dialogMeta').textContent = 'แฟ้มนี้ถูกเก็บออกจากรายชื่อผู้ป่วยแล้ว';
  } catch (e) {
    if (!stillOpen()) return;
    $('#dialogMeta').textContent = 'เปิดแฟ้มไม่สำเร็จ';
    showError($('#patientError'), e.message);
  }
}
function fillPatient(p) {
  Object.entries({
    patientId: p.id,
    patientDemo: p.demo,
    patientZone: p.zone,
    patientTriagePoint: p.triagePoint,
    patientDecon: p.deconStatus,
    patientTransport: p.transport,
    patientCc: p.cc,
    patientRr: p.rr,
    patientHr: p.hr,
    patientBp: p.bp,
    patientSpo2: p.spo2,
    patientGcs: p.gcs,
  }).forEach(([id, value]) => {
    const node = $(`#${id}`);
    if (node) node.value = value || '';
  });
  $('#patientColor').value = p.color || '';
  $$('.triage-option').forEach((b) =>
    b.classList.toggle('selected', b.dataset.color === p.color),
  );
  $$('#interventionPicker input').forEach((i) => {
    i.checked = (p.interventions || []).includes(i.value);
  });
}
function renderHistory() {
  const root = $('#historyList');
  root.replaceChildren();
  if (!state.history.length) {
    root.append(el('p', 'muted', 'ยังไม่มีประวัติ'));
    return;
  }
  state.history.forEach((h) => {
    const item = el('article', 'history-item');
    item.append(
      el('strong', null, `${fmtDate(h.updatedAt)} · ${h.staff || 'ไม่ระบุชื่อ'}`),
      el('p', null, h.note || 'มีการอัปเดตข้อมูลผู้ป่วย'),
      el(
        'small',
        null,
        `${colorLabels[h.color] || text(h.color)} · ${zoneLabels[h.zone] || text(h.zone)} · ${vitalText(h)}`,
      ),
    );
    root.append(item);
  });
}
function renderStockHistory(movements) {
  const panel = $('#stockHistory');
  panel.hidden = !movements.length;
  const list = panel.querySelector('ul');
  list.replaceChildren(
    ...movements.map((movement) => {
      const supply = state.overview.stock.find(
        (item) => item.id === movement.stockId,
      );
      return el(
        'li',
        null,
        `${supply?.name || movement.stockId} · ${movement.quantity} ${supply?.unit || 'หน่วย'} · ${fmtDate(movement.createdAt)}`,
      );
    }),
  );
}
function formBody() {
  const form = $('#patientForm');
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.id = body.id.trim().toUpperCase();
  body.color = $('#patientColor').value;
  body.interventions = $$('#interventionPicker input:checked').map(
    (i) => i.value,
  );
  body.stockUsage = $$('#stockUsagePicker input')
    .map((input) => ({
      stockId: input.dataset.stockId,
      quantity: Number(input.value) || 0,
    }))
    .filter((movement) => movement.quantity > 0);
  body.requestId = state.requestId;
  return body;
}
async function savePatient(event) {
  event.preventDefault();
  const saveButton = $('#savePatientBtn');
  if (saveButton.disabled) return;
  const body = formBody();
  if (!body.color) {
    showError($('#patientError'), 'กรุณาเลือกสี Triage ให้ชัดเจน');
    return;
  }
  if (!body.id && state.selectedPatient) body.id = state.selectedPatient.id;
  const isEdit = Boolean(state.selectedPatient);
  if (isEdit) body.version = state.selectedPatient.version;
  saveButton.disabled = true;
  try {
    const result = await api(
      isEdit
        ? `/api/patients/${encodeURIComponent(state.selectedPatient.id)}`
        : '/api/patients',
      { method: isEdit ? 'PATCH' : 'POST', body },
    );
    state.selectedPatient = result.patient;
    state.history = result.history || [];
    $$('#stockUsagePicker input').forEach((input) => {
      input.value = '0';
    });
    notify('บันทึกข้อมูลผู้ป่วยแล้ว');
    $('#patientDialog').close();
    await refresh();
  } catch (e) {
    const message = /insuff|stock|เวชภัณฑ์/i.test(e.message)
      ? e.message
      : e.status === 409
        ? /stale|version/i.test(e.message)
          ? 'ข้อมูลถูกแก้ไขโดยเจ้าหน้าที่อื่น กรุณาปิดแล้วโหลดใหม่'
          : e.message
        : e.message;
    showError($('#patientError'), message);
  } finally {
    saveButton.disabled = false;
  }
}

async function loadSession() {
  try {
    const result = await api('/api/session');
    if (result?.demoUsername) {
      $('#demoUsername').textContent = result.demoUsername;
      $('#demoLoginNote').hidden = false;
    }
    if (result?.staff) {
      state.session = result.staff;
      enterApp();
    }
  } catch (_) {
    /* unauthenticated */
  }
}
async function login(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData($('#loginForm')).entries());
  const error = $('#loginError');
  if (!body.username?.trim()) {
    showError(error, 'กรุณากรอกชื่อผู้ใช้');
    return;
  }
  try {
    const result = await api('/api/session', { method: 'POST', body });
    state.session = result.staff || body;
    enterApp();
    notify('เข้าสู่ระบบสำเร็จ');
  } catch (e) {
    showError(error, e.message);
  }
}
async function register(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData($('#registerForm')).entries());
  const error = $('#registerError');
  if (
    ![body.name, body.org, body.duty, body.opZone].every((value) =>
      value?.trim(),
    )
  ) {
    showError(error, 'กรุณากรอกข้อมูลที่มีเครื่องหมาย * ให้ครบ');
    return;
  }
  body.personnelCode = body.personnelCode?.trim() || '000';
  try {
    const result = await api('/api/register', { method: 'POST', body });
    state.session = result.staff;
    enterApp();
    notify(`ลงทะเบียนสำเร็จ ชื่อผู้ใช้: ${result.username}`);
  } catch (e) {
    showError(error, e.message);
  }
}
function setAuthMode(mode) {
  const loginMode = mode === 'login';
  $('#loginForm').hidden = !loginMode;
  $('#registerForm').hidden = loginMode;
  $('#loginTab').classList.toggle('active', loginMode);
  $('#registerTab').classList.toggle('active', !loginMode);
  $('#loginTab').setAttribute('aria-selected', String(loginMode));
  $('#registerTab').setAttribute('aria-selected', String(!loginMode));
}
async function enterApp() {
  $('#authView').hidden = true;
  $('#mainView').hidden = false;
  $('#sessionLabel').textContent =
    `${state.session.name} · ${state.session.duty}`;
  $('#sideProfile').textContent =
    `${state.session.name} · ${state.session.org}\n${state.session.opZone}`;
  $('#assignedUsername').textContent =
    `ชื่อผู้ใช้: ${state.session.username || '—'}`;
  $('#mobileUsername').textContent = state.session.username || '';
  $('#copyUsernameBtn').hidden = !state.session.username;
  renderNav();
  navigate('overview');
  const qrPatientId = patientIdFromUrl();
  const qrIncidentId = qrPatientId
    ? new URLSearchParams(location.search).get('incident') || 'legacy'
    : null;
  try {
    await loadIncidents();
    const pinned = state.incidents.find((item) => item.id === qrIncidentId);
    const previous = state.incidents.find(
      (item) => item.id === sessionStorage.getItem('thaisim-incident'),
    );
    const incident =
      pinned ||
      previous ||
      state.incidents.find((item) => !item.closedAt) ||
      state.incidents[0];
    if (incident) await selectIncident(incident, { preserveQr: true });
    if (qrPatientId && pinned && state.incident?.id === pinned.id)
      openPatient(qrPatientId);
    else if (qrPatientId && !pinned) notify('ไม่พบเหตุการณ์ที่ระบุในการ์ดนี้', 'error');
    const accountId = state.session?.id;
    api('/api/sheets/status')
      .then((payload) => {
        if (state.session?.id !== accountId) return;
        state.sheetSync = payload;
        const panel = $('.sheet-dashboard');
        if (panel && state.activePage === 'overview')
          panel.replaceWith(renderSheetPanel());
      })
      .catch(() => {});
    clearInterval(state.presenceTimer);
    state.presenceTimer = setInterval(sendPresence, 30_000);
  } catch (error) {
    notify(error.message, 'error');
  }
}
async function sendPresence() {
  const incidentId = state.incident?.id;
  const accountId = state.session?.id;
  if (!accountId || !incidentId || document.visibilityState !== 'visible')
    return;
  try {
    const data = await api('/api/presence', { method: 'POST', body: {} });
    if (state.incident?.id !== incidentId || state.session?.id !== accountId)
      return;
    state.overview.onlineStaffCount = data.onlineStaffCount;
    const node = $('#onlineCount');
    if (node) node.textContent = `เจ้าหน้าที่ออนไลน์ ${data.onlineStaffCount} คน`;
  } catch {
    // The next heartbeat updates presence after a temporary connection issue.
  }
}
async function logout() {
  try {
    await api('/api/session', { method: 'DELETE' });
  } catch (_) {
    /* still clear local view */
  }
  state.session = null;
  state.incident = null;
  state.overview = { patients: [], stock: [] };
  state.sheetSync = null;
  clearInterval(state.presenceTimer);
  state.presenceTimer = null;
  $('#mainView').hidden = true;
  $('#authView').hidden = false;
  $('#loginForm').reset();
  setAuthMode('login');
}
document.addEventListener('DOMContentLoaded', () => {
  $('#loginForm').addEventListener('submit', login);
  $('#registerForm').addEventListener('submit', register);
  $('#loginTab').addEventListener('click', () => setAuthMode('login'));
  $('#registerTab').addEventListener('click', () => setAuthMode('register'));
  $('#copyDemoUsername').addEventListener('click', async () => {
    const username = $('#demoUsername').textContent;
    const input = $('#username');
    input.value = username;
    showError($('#loginError'), '');
    try {
      await navigator.clipboard.writeText(username);
      notify('คัดลอกชื่อผู้ใช้เดโมแล้ว');
    } catch {
      input.focus();
      input.select();
      notify('เลือกชื่อไว้ในช่องแล้ว กดคัดลอกหรือเข้าสู่ระบบได้เลย');
    }
  });
  $('#copyUsernameBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.session.username);
      notify('คัดลอกชื่อผู้ใช้แล้ว');
    } catch (_) {
      notify('คัดลอกไม่สำเร็จ', 'error');
    }
  });
  $('#mobileUsername').addEventListener('click', () =>
    $('#copyUsernameBtn').click(),
  );
  document.addEventListener('visibilitychange', sendPresence);
  $('#patientForm').addEventListener('submit', savePatient);
  $('#closeDialogBtn').addEventListener('click', () =>
    $('#patientDialog').close(),
  );
  $('#logoutBtn').addEventListener('click', logout);
  $('#refreshBtn').addEventListener('click', refresh);
  $$('.triage-option').forEach((b) =>
    b.addEventListener('click', () => {
      $('#patientColor').value = b.dataset.color;
      $$('.triage-option').forEach((x) =>
        x.classList.toggle('selected', x === b),
      );
    }),
  );
  $('#interventionPicker').replaceChildren(
    ...interventions.map((value) => {
      const label = el('label', 'chip');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = value;
      label.append(input, document.createTextNode(value));
      return label;
    }),
  );
  loadSession();
});

export { state, renderPatients, openPatient };
