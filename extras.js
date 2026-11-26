import { CHEMICALS, ERG_SOURCES } from './erg-data.js';

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export const normalizeCardCount = (value) =>
  Math.max(
    1,
    Math.min(
      500,
      Number.isFinite(Number(value)) && Number(value) > 0
        ? Math.floor(Number(value))
        : 12,
    ),
  );
export const normalizeStartCode = (value) =>
  Math.max(
    1,
    Math.min(
      999999,
      Number.isFinite(Number(value)) && Number(value) > 0
        ? Math.floor(Number(value))
        : 1,
    ),
  );
export const filterChemicals = (items, query) => {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  return !q
    ? items
    : items.filter((x) =>
        [x.un, x.nameEn, x.nameThai].some((v) =>
          String(v).toLowerCase().includes(q),
        ),
      );
};

function field(label, type, name, value, attrs = '') {
  return `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${attrs}></label>`;
}
function pageHead(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="page-actions">${actions}</div></div>`;
}

function renderStock(root, state, api, notify, incidentClosed) {
  let stock = state.stock || [];
  let saving = false;
  root.innerHTML =
    pageHead(
      'คลังเวชภัณฑ์',
      'ติดตามจำนวนคงเหลือและแจ้งเตือนของใกล้หมด',
      '<button class="btn btn-danger stock-reset" type="button">รีเซ็ตข้อมูลสาธิต</button>',
    ) +
    `<section class="panel stock-controls"><div class="panel-head"><h2>รายการเวชภัณฑ์</h2><span class="badge stock-count"></span></div><div class="filters"><input class="stock-search" type="search" placeholder="ค้นหาชื่อหรือหมวดหมู่" aria-label="ค้นหาเวชภัณฑ์"></div><div class="table-wrap"><table><thead><tr><th>รายการ</th><th>หมวด</th><th>คงเหลือ</th><th>อัปเดต</th><th>การปรับจำนวน</th></tr></thead><tbody class="stock-rows"></tbody></table></div></section>` +
    `<section class="panel stock-add"><div class="panel-head"><h2>เพิ่มรายการใหม่</h2></div><form class="form-grid stock-form">${field('ชื่อรายการ', 'text', 'name', '', 'required maxlength="120"')} ${field('หมวดหมู่', 'text', 'category', 'General', 'required maxlength="80"')} ${field('จำนวน', 'number', 'qty', '0', 'min="0" step="1" required')} ${field('หน่วย', 'text', 'unit', 'ชิ้น', 'required maxlength="30"')} ${field('แจ้งเตือนเมื่อเหลือไม่เกิน', 'number', 'minAlert', '0', 'min="0" step="1" required')}<div class="page-actions"><button class="btn btn-primary" type="submit">เพิ่มเข้าคลัง</button></div></form></section>`;
  const rows = root.querySelector('.stock-rows');
  const drawRows = () => {
    const q = root.querySelector('.stock-search').value.trim().toLowerCase();
    root.querySelector('.stock-count').textContent = `${stock.length} รายการ`;
    rows.innerHTML =
      stock
        .filter((x) => `${x.name} ${x.category}`.toLowerCase().includes(q))
        .map((x) => {
          const low = Number(x.qty) <= Number(x.minAlert);
          const timestamp = x.updatedAt
            ? new Date(x.updatedAt).toLocaleString('th-TH', {
                dateStyle: 'short',
                timeStyle: 'short',
              })
            : '—';
          return `<tr><td><strong>${esc(x.name)}</strong><br><small>${esc(x.id)}</small></td><td>${esc(x.category)}</td><td><span class="badge ${low ? 'badge-low' : 'badge-ok'}">${esc(x.qty)} ${esc(x.unit)}${low ? ' · ใกล้หมด' : ''}</span></td><td>${esc(timestamp)}<br><small>${esc(x.staff || '-')}</small></td><td><div class="stock-stepper"><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="-5" type="button" aria-label="ลด ${esc(x.name)} 5">−5</button><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="-1" type="button" aria-label="ลด ${esc(x.name)} 1">−1</button><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="1" type="button" aria-label="เพิ่ม ${esc(x.name)} 1">+1</button><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="5" type="button" aria-label="เพิ่ม ${esc(x.name)} 5">+5</button></div></td></tr>`;
        })
        .join('') || '<tr><td colspan="5" class="empty">ไม่พบรายการ</td></tr>';
  };
  drawRows();
  root.querySelector('.stock-search').addEventListener('input', drawRows);
  if (incidentClosed) {
    root.querySelector('.stock-reset').hidden = true;
    root.querySelector('.stock-add').hidden = true;
    root
      .querySelector('.stock-controls table')
      .classList.add('stock-read-only');
    return;
  }
  async function save(control, pathname, options, message, form) {
    if (saving) return;
    saving = true;
    control.disabled = true;
    try {
      const result = await api(pathname, options);
      state.stock = stock = result.stock;
      form?.reset();
      if (root.contains(rows)) drawRows();
      notify(message);
    } catch (e) {
      notify(e.message || 'บันทึกคลังไม่สำเร็จ', 'error');
    } finally {
      control.disabled = false;
      saving = false;
    }
  }
  rows.addEventListener('click', (event) => {
    const control = event.target.closest('.stock-delta');
    if (!control) return;
    save(
      control,
      `/api/stock/${encodeURIComponent(control.dataset.id)}`,
      { method: 'PATCH', body: { delta: Number(control.dataset.delta) } },
      'อัปเดตจำนวนแล้ว',
    );
  });
  const form = root.querySelector('.stock-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    save(
      form.querySelector('button'),
      '/api/stock',
      {
        method: 'POST',
        body: {
          ...data,
          qty: Number(data.qty),
          minAlert: Number(data.minAlert),
        },
      },
      'เพิ่มรายการแล้ว',
      form,
    );
  });
  root.querySelector('.stock-reset').addEventListener('click', (event) => {
    if (!window.confirm('รีเซ็ตคลังกลับเป็นข้อมูลฝึกซ้อมตั้งต้นหรือไม่?')) return;
    save(
      event.currentTarget,
      '/api/stock/reset',
      { method: 'POST', body: {} },
      'รีเซ็ตคลังแล้ว',
    );
  });
}

function renderErg(root) {
  root.innerHTML =
    pageHead(
      'คู่มือสารเคมี',
      'ค้นเลข UN หรือชื่อสารเคมี และเปิดคู่มือ ERG4Thai ของกรมควบคุมมลพิษ',
    ) +
    `<section class="panel">
      <div class="page-actions" aria-label="ช่องทางเปิด ERG4Thai">
        <a class="btn btn-primary" href="${ERG_SOURCES.web}" target="_blank" rel="noopener">เปิดเว็บ ERG4Thai</a>
        <a class="btn btn-secondary" href="${ERG_SOURCES.ios}" target="_blank" rel="noopener">แอป iPhone / iPad</a>
        <a class="btn btn-secondary" href="${ERG_SOURCES.android}" target="_blank" rel="noopener">แอป Android</a>
      </div>
    </section>
    <section class="panel"><div class="filters"><input class="erg-search" type="search" placeholder="ค้นหา UN / ชื่อไทย / ชื่ออังกฤษ" aria-label="ค้นหาสารเคมี"></div><div class="erg-results"></div><div class="resource-links"><a href="${ERG_SOURCES.thai}" target="_blank" rel="noopener">คู่มือกรมควบคุมมลพิษ</a> · <a href="${ERG_SOURCES.phmsa}" target="_blank" rel="noopener">U.S. PHMSA ERG</a> · <a href="${ERG_SOURCES.erg2024}" target="_blank" rel="noopener">ERG2024 PDF</a></div></section>`;
  const search = root.querySelector('.erg-search'),
    results = root.querySelector('.erg-results');
  const draw = () => {
    const list = filterChemicals(CHEMICALS, search.value);
    results.innerHTML = list.length
      ? list
          .map(
            (x) =>
              `<article class="erg-result"><div><strong>UN ${esc(x.un)}</strong> · ${esc(x.nameThai)}<br><span>${esc(x.nameEn)}</span></div><span class="badge badge-guide">Guide ${esc(x.guide)}</span><a href="${esc(x.source)}" target="_blank" rel="noopener" aria-label="เปิดแหล่งข้อมูล ERG สำหรับ ${esc(x.nameEn)}">แหล่งข้อมูล</a></article>`,
          )
          .join('')
      : '<p class="empty">ไม่พบสารเคมีที่ตรงกัน</p>';
  };
  search.addEventListener('input', draw);
  draw();
}

export function qrImagePath(code, incidentId = 'legacy') {
  return `/api/qr/${encodeURIComponent(code)}.png?incident=${encodeURIComponent(incidentId)}`;
}
function qrCard(code, index, incidentId, incidentName) {
  return `<article class="qr-card"><div class="qr-caption"><strong>${code}</strong><span>${esc(incidentName || 'ThaiSIM MCI · การ์ดฝึกซ้อม')}</span></div><img src="${qrImagePath(code, incidentId)}" alt="QR สำหรับรหัส ${code}" loading="${index < 12 ? 'eager' : 'lazy'}" width="115" height="115"><div class="qr-bands"><span class="badge badge-red">แดง</span><span class="badge badge-yellow">เหลือง</span><span class="badge badge-green">เขียว</span><span class="badge badge-black">ดำ</span></div></article>`;
}
function renderCards(root, notify, incidentId, incidentName) {
  root.innerHTML =
    pageHead(
      'พิมพ์การ์ด QR',
      'เตรียมการ์ดสำหรับแจกตอนฝึกซ้อม สแกนด้วยกล้องมือถือเพื่อเปิดหรือขึ้นทะเบียนแฟ้มตามรหัส',
    ) +
    `<section class="panel"><form class="qr-controls">
    <label class="field"><span>จำนวนบัตร</span><input name="count" type="number" min="1" max="500" value="12" aria-describedby="qr-help" required></label>
    <label class="field"><span>รหัสเริ่มต้น</span><input name="start" type="number" min="1" max="999999" value="1" required></label>
    <div class="page-actions"><button class="btn btn-secondary" type="submit">สร้างตัวอย่าง</button><button class="btn btn-primary qr-print" type="button">พิมพ์</button></div>
    </form><small id="qr-help">พิมพ์ได้ครั้งละ 1–500 ใบ การ์ดผูกกับเหตุการณ์ที่เลือก</small></section><section id="print-area" class="qr-grid" aria-label="ตัวอย่างการ์ด QR"></section>`;
  const form = root.querySelector('.qr-controls');
  const area = root.querySelector('#print-area');
  let range = '';
  function draw() {
    const data = Object.fromEntries(new FormData(form));
    const count = normalizeCardCount(data.count);
    const start = normalizeStartCode(data.start);
    if (start + count - 1 > 999999) {
      notify('รหัสสุดท้ายต้องไม่เกิน MCI-999999', 'error');
      return false;
    }
    const next = `${start}:${count}`;
    if (next === range) return true;
    range = next;
    area.innerHTML = Array.from({ length: count }, (_, i) =>
      qrCard(
        `MCI-${String(start + i).padStart(3, '0')}`,
        i,
        incidentId,
        incidentName,
      ),
    ).join('');
    return true;
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    draw();
  });
  const print = root.querySelector('.qr-print');
  print.addEventListener('click', async () => {
    if (!form.reportValidity() || !draw()) return;
    print.disabled = true;
    try {
      const images = [...area.querySelectorAll('img')];
      images.forEach((img) => {
        img.loading = 'eager';
      });
      await Promise.all(images.map((img) => img.decode()));
      if (print.isConnected && !root.hidden) window.print();
    } catch {
      notify('โหลด QR ไม่ครบ กรุณารีเฟรชหน้าแล้วลองใหม่', 'error');
    } finally {
      print.disabled = false;
    }
  });
  draw();
}

export function renderExtras(
  page,
  { root, state, api, notify, incidentId, incidentName, incidentClosed },
) {
  if (!root) throw new Error('Extras root is required');
  if (page === 'stock') renderStock(root, state, api, notify, incidentClosed);
  else if (page === 'erg') renderErg(root);
  else if (page === 'cards')
    renderCards(root, notify, incidentId, incidentName);
  else root.innerHTML = '<p class="empty">ไม่พบหน้าที่เลือก</p>';
  return root;
}
