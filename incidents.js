import crypto from 'node:crypto';
import QRCode from 'qrcode';

const COLORS = new Set(['red', 'yellow', 'green', 'black']);
const ZONES = new Set([
  'triage',
  'decon',
  'treatment',
  'staging',
  'evacuated',
  'discharged',
  'morgue',
]);
const POINTS = new Set(['primary', 'secondary', '']);
const DECON = new Set(['none', 'pending', 'in-progress', 'cleared']);
const DEFAULT_STOCK = [
  ['STK-01', 'Oxygen Tank + Mask', 'Airway', 20, 'ถัง', 5],
  ['STK-02', 'IV Set + 0.9% NSS', 'Circulation', 50, 'ชุด', 10],
  ['STK-03', 'Tourniquet / Gauze', 'Bleeding', 30, 'ชุด', 8],
  ['STK-04', 'Decon Wash Kit', 'Decontamination', 25, 'ชุด', 6],
  ['STK-05', 'C-Collar / Spine Board', 'Immobilization', 12, 'ชุด', 3],
  ['STK-06', 'Cold Pack / Dressing', 'General', 40, 'ชิ้น', 10],
];
const now = () => new Date().toISOString();
const idOk = (id) =>
  /^MCI-\d{3,6}$/.test(String(id || '')) &&
  Number(String(id).slice(4)) > 0 &&
  String(id) === `MCI-${String(Number(String(id).slice(4))).padStart(3, '0')}`;
const normalizeId = (v) =>
  String(v || '')
    .trim()
    .toUpperCase();
const incidentId = (req) =>
  String(req.get('x-incident-id') || req.query.incident || 'legacy')
    .trim()
    .toLowerCase();
const parseInterventions = (v) => {
  try {
    return JSON.parse(v || '[]');
  } catch {
    return [];
  }
};
const jsonPatient = (p) =>
  p && { ...p, interventions: parseInterventions(p.interventions) };

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((x) => x.name === column);
}
function addColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function initIncidents(db) {
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, closedAt TEXT)`,
    );
    const t = now();
    db.prepare(
      "INSERT OR IGNORE INTO incidents (id,name,status,createdAt,updatedAt) VALUES ('legacy','ข้อมูลเดิม', 'open', ?, ?)",
    ).run(t, t);
    addColumn(db, 'patients', 'incidentId', "TEXT NOT NULL DEFAULT 'legacy'");
    addColumn(db, 'patients', 'deletedAt', 'TEXT');
    addColumn(db, 'history', 'incidentId', "TEXT NOT NULL DEFAULT 'legacy'");
    addColumn(db, 'stock', 'incidentId', "TEXT NOT NULL DEFAULT 'legacy'");
    // v1 used a global id primary key. Rebuild once so each incident can retain
    // its own MCI/STK namespace while copying every existing value verbatim.
    const patientPk = db
      .prepare('PRAGMA table_info(patients)')
      .all()
      .filter((x) => x.pk)
      .map((x) => x.name);
    if (patientPk.length === 1 && patientPk[0] === 'id') {
      db.exec(`ALTER TABLE patients RENAME TO patients__v1;
        CREATE TABLE patients (id TEXT NOT NULL, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, demo TEXT NOT NULL, cc TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL, version INTEGER NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL, incidentId TEXT NOT NULL DEFAULT 'legacy', deletedAt TEXT, PRIMARY KEY (id,incidentId));
        INSERT INTO patients SELECT id,color,zone,triagePoint,deconStatus,demo,cc,rr,hr,bp,spo2,gcs,interventions,transport,version,staff,updatedAt,incidentId,deletedAt FROM patients__v1;
        DROP TABLE patients__v1`);
    }
    const stockPk = db
      .prepare('PRAGMA table_info(stock)')
      .all()
      .filter((x) => x.pk)
      .map((x) => x.name);
    if (stockPk.length === 1 && stockPk[0] === 'id') {
      db.exec(`ALTER TABLE stock RENAME TO stock__v1;
        CREATE TABLE stock (id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, qty INTEGER NOT NULL, unit TEXT NOT NULL, minAlert INTEGER NOT NULL, updatedAt TEXT NOT NULL, staff TEXT NOT NULL, incidentId TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY (id,incidentId));
        INSERT INTO stock SELECT id,name,category,qty,unit,minAlert,updatedAt,staff,incidentId FROM stock__v1;
        DROP TABLE stock__v1`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_patients_incident ON patients(incidentId,id);
      CREATE INDEX IF NOT EXISTS idx_history_incident_patient ON history(incidentId,patientId,seq);
      CREATE INDEX IF NOT EXISTS idx_stock_incident ON stock(incidentId,id);
      CREATE TABLE IF NOT EXISTS stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, incidentId TEXT NOT NULL, patientId TEXT NOT NULL, patientVersion INTEGER NOT NULL, stockId TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), staff TEXT NOT NULL, createdAt TEXT NOT NULL, requestId TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_patient ON stock_movements(incidentId,patientId);
      CREATE TABLE IF NOT EXISTS incident_mutations (requestId TEXT PRIMARY KEY, incidentId TEXT NOT NULL, patientId TEXT NOT NULL, createdAt TEXT NOT NULL)`);
    db.exec('PRAGMA user_version=2');
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  }
}

function getIncident(db, id) {
  return db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
}
function requireIncident(db, req, mutate = false) {
  const id = incidentId(req),
    row = getIncident(db, id);
  if (!row) {
    const e = new Error('incident not found');
    e.status = 404;
    throw e;
  }
  if (mutate && row.status !== 'open') {
    const e = new Error('incident is closed');
    e.status = 409;
    throw e;
  }
  return row;
}
function sendError(res, e, fallback = 400) {
  return res
    .status(e.status || fallback)
    .json({ error: e.message || String(e) });
}
function staffName(req, staffLabel) {
  return staffLabel ? staffLabel(req.staff) : req.staff?.name || 'ไม่ระบุชื่อ';
}
function patientRow(db, id, scope, includeArchived = true) {
  const q = includeArchived
    ? 'SELECT * FROM patients WHERE id=? AND incidentId=?'
    : 'SELECT * FROM patients WHERE id=? AND incidentId=? AND deletedAt IS NULL';
  return db.prepare(q).get(id, scope);
}
function historyRows(db, id, scope) {
  return db
    .prepare(
      'SELECT * FROM history WHERE patientId=? AND incidentId=? ORDER BY seq DESC',
    )
    .all(id, scope)
    .map((h) => ({ ...h, interventions: parseInterventions(h.interventions) }));
}
function movements(db, id, scope) {
  return db
    .prepare(
      'SELECT * FROM stock_movements WHERE patientId=? AND incidentId=? ORDER BY id DESC',
    )
    .all(id, scope);
}
function patientResponse(db, id, scope) {
  return {
    patient: jsonPatient(patientRow(db, id, scope)),
    history: historyRows(db, id, scope),
    stockMovements: movements(db, id, scope),
  };
}
function nextId(db, scope) {
  const rows = db
    .prepare('SELECT id FROM patients WHERE incidentId=?')
    .all(scope);
  let n = 1;
  while (rows.some((x) => x.id === `MCI-${String(n).padStart(3, '0')}`)) n += 1;
  return `MCI-${String(n).padStart(3, '0')}`;
}
function validatePatient(data) {
  const p = {
    color: data.color,
    zone: data.zone || 'triage',
    triagePoint: data.triagePoint || '',
    deconStatus: data.deconStatus || 'none',
  };
  if (
    !COLORS.has(p.color) ||
    !ZONES.has(p.zone) ||
    !POINTS.has(p.triagePoint) ||
    !DECON.has(p.deconStatus)
  )
    throw new Error('invalid patient fields');
  return p;
}

function savePatient(
  db,
  { scope, data, actor, id, version, requestId, isEdit, inTransaction = false },
) {
  const incident = getIncident(db, scope);
  if (!incident)
    throw Object.assign(new Error('incident not found'), { status: 404 });
  if (incident.status !== 'open')
    throw Object.assign(new Error('incident is closed'), { status: 409 });
  if (!inTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    if (requestId) {
      const prior = db
        .prepare(
          'SELECT patientId FROM incident_mutations WHERE requestId=? AND incidentId=?',
        )
        .get(requestId, scope);
      if (prior) {
        if (!inTransaction) db.exec('COMMIT');
        return { replay: true, ...patientResponse(db, prior.patientId, scope) };
      }
    }
    const old = id ? patientRow(db, id, scope) : null;
    if (isEdit && (!old || old.deletedAt || old.version !== version)) {
      const e = new Error('stale version');
      e.status = 409;
      throw e;
    }
    if (!isEdit && id && old) {
      const e = new Error('duplicate patient id');
      e.status = 409;
      throw e;
    }
    if (!id) id = nextId(db, scope);
    if (!idOk(id)) throw new Error('invalid patient id');
    const p = validatePatient({ ...(old || {}), ...data });
    const t = now(),
      v = old ? old.version + 1 : 1;
    const interventions =
      data.interventions !== undefined
        ? data.interventions
        : old
          ? parseInterventions(old.interventions)
          : [];
    const vals = [
      p.color,
      p.zone,
      p.triagePoint,
      p.deconStatus,
      data.demo ?? old?.demo ?? '',
      data.cc ?? old?.cc ?? '',
      data.rr ?? old?.rr ?? '',
      data.hr ?? old?.hr ?? '',
      data.bp ?? old?.bp ?? '',
      data.spo2 ?? old?.spo2 ?? '',
      data.gcs ?? old?.gcs ?? '',
      JSON.stringify(interventions),
      data.transport ?? old?.transport ?? '',
    ];
    if (old) {
      const result = db
        .prepare(
          'UPDATE patients SET color=?,zone=?,triagePoint=?,deconStatus=?,demo=?,cc=?,rr=?,hr=?,bp=?,spo2=?,gcs=?,interventions=?,transport=?,version=?,staff=?,updatedAt=? WHERE id=? AND incidentId=? AND version=?',
        )
        .run(...vals, v, actor, t, id, scope, version);
      if (result.changes !== 1) {
        const e = new Error('stale version');
        e.status = 409;
        throw e;
      }
    } else {
      db.prepare(
        'INSERT INTO patients (id,color,zone,triagePoint,deconStatus,demo,cc,rr,hr,bp,spo2,gcs,interventions,transport,version,staff,updatedAt,incidentId,deletedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
      ).run(id, ...vals, v, actor, t, scope);
    }
    db.prepare(
      'INSERT INTO history (patientId,note,staff,updatedAt,color,zone,triagePoint,deconStatus,rr,hr,bp,spo2,gcs,interventions,transport,incidentId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      data.note || '',
      actor,
      t,
      ...[
        p.color,
        p.zone,
        p.triagePoint,
        p.deconStatus,
        vals[6],
        vals[7],
        vals[8],
        vals[9],
        vals[10],
        vals[11],
        vals[12],
      ],
      scope,
    );
    const usage = Array.isArray(data.stockUsage) ? data.stockUsage : [];
    const usageIds = new Set();
    for (const u of usage) {
      if (!u || !Number.isInteger(u.quantity) || u.quantity <= 0)
        throw new Error('invalid stock usage');
      if (usageIds.has(u.stockId)) throw new Error('duplicate stock usage');
      usageIds.add(u.stockId);
      const changed = db
        .prepare(
          'UPDATE stock SET qty=qty-?,updatedAt=?,staff=? WHERE id=? AND incidentId=? AND qty>=?',
        )
        .run(u.quantity, t, actor, u.stockId, scope, u.quantity);
      if (changed.changes !== 1) {
        const e = new Error('insufficient stock');
        e.status = 409;
        throw e;
      }
      db.prepare(
        'INSERT INTO stock_movements (incidentId,patientId,patientVersion,stockId,quantity,staff,createdAt,requestId) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        scope,
        id,
        v,
        u.stockId,
        u.quantity,
        actor,
        t,
        requestId ? `${requestId}:${u.stockId}` : null,
      );
    }
    if (requestId)
      db.prepare('INSERT INTO incident_mutations VALUES (?,?,?,?)').run(
        requestId,
        scope,
        id,
        t,
      );
    if (!inTransaction) db.exec('COMMIT');
    return patientResponse(db, id, scope);
  } catch (e) {
    if (!inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
    throw e;
  }
}

export function triageReview(db, scope) {
  const observations = db
    .prepare(
      `
    SELECT history.patientId AS id, history.triagePoint, history.color
    FROM history JOIN patients
      ON patients.incidentId = history.incidentId AND patients.id = history.patientId
    WHERE history.incidentId = ? AND patients.deletedAt IS NULL
      AND history.triagePoint IN ('primary', 'secondary')
      AND history.color IN ('green', 'yellow', 'red', 'black')
    ORDER BY history.patientId, history.seq
  `,
    )
    .all(scope);
  const pairs = new Map();
  for (const { id, triagePoint, color } of observations) {
    if (triagePoint === 'primary' && !pairs.has(id)) {
      pairs.set(id, { id, primary: color });
    } else if (triagePoint === 'secondary') {
      const pair = pairs.get(id);
      if (pair && !pair.secondary) pair.secondary = color;
    }
  }
  const matched = [...pairs.values()].filter((pair) => pair.secondary);
  const directional = matched.filter(
    (pair) => pair.primary !== 'black' && pair.secondary !== 'black',
  );
  const primaryCases = pairs.size;
  const matchedCases = matched.length;
  const rank = { green: 1, yellow: 2, red: 3 };
  return {
    matchedCases,
    primaryCases,
    withoutSecondary: primaryCases - matchedCases,
    coveragePercent: primaryCases
      ? Math.round((matchedCases / primaryCases) * 100)
      : null,
    higherDirection: directional.filter(
      (x) => rank[x.secondary] > rank[x.primary],
    ).length,
    lowerDirection: directional.filter(
      (x) => rank[x.secondary] < rank[x.primary],
    ).length,
    unchanged: directional.filter((x) => x.secondary === x.primary).length,
    blackCases: matchedCases - directional.length,
    changes: matched.filter((pair) => pair.primary !== pair.secondary),
  };
}

export function archivePatient(
  db,
  { scope, id, version, actor, inTransaction = false },
) {
  const incident = getIncident(db, scope);
  if (!incident)
    throw Object.assign(new Error('incident not found'), { status: 404 });
  if (incident.status !== 'open')
    throw Object.assign(new Error('incident is closed'), { status: 409 });
  const old = patientRow(db, id, scope);
  if (!old)
    throw Object.assign(new Error('patient not found'), { status: 404 });
  if (!Number.isInteger(version) || old.version !== version)
    throw Object.assign(new Error('stale version'), { status: 409 });
  if (!inTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const result = db
      .prepare(
        'UPDATE patients SET deletedAt=?,version=version+1,updatedAt=?,staff=? WHERE id=? AND incidentId=? AND version=? AND deletedAt IS NULL',
      )
      .run(now(), now(), actor, id, scope, version);
    if (result.changes !== 1)
      throw Object.assign(new Error('stale version'), { status: 409 });
    if (!inTransaction) db.exec('COMMIT');
    return patientResponse(db, id, scope);
  } catch (e) {
    if (!inTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

export function registerIncidentRoutes(
  app,
  { db, auth, getOnlineCount, staffLabel, publicOrigin } = {},
) {
  const guard = auth || ((_req, _res, next) => next());
  app.get('/api/incidents', guard, (_req, res) =>
    res.json({
      incidents: db
        .prepare('SELECT * FROM incidents ORDER BY createdAt DESC')
        .all(),
    }),
  );
  app.post('/api/incidents', guard, (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) throw new Error('incident name is required');
      const id = `inc-${crypto.randomUUID().slice(0, 8)}`,
        t = now();
      db.exec('BEGIN IMMEDIATE');
      db.prepare(
        "INSERT INTO incidents (id,name,status,createdAt,updatedAt) VALUES (?,? ,'open',?,?)",
      ).run(id, name, t, t);
      const q = db.prepare(
        'INSERT INTO stock (id,name,category,qty,unit,minAlert,updatedAt,staff,incidentId) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      for (const x of DEFAULT_STOCK) q.run(...x, t, 'ระบบ', id);
      db.exec('COMMIT');
      res.status(201).json({ incident: getIncident(db, id) });
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      sendError(res, e);
    }
  });
  app.patch('/api/incidents/:id', guard, (req, res) => {
    try {
      const row = getIncident(db, req.params.id);
      if (!row)
        throw Object.assign(new Error('incident not found'), { status: 404 });
      if (row.status === 'closed')
        throw Object.assign(new Error('incident is immutable'), {
          status: 409,
        });
      if (!(req.body?.status === 'closed' || req.body?.closed === true))
        throw new Error('only close is supported');
      const t = now();
      db.prepare(
        "UPDATE incidents SET status='closed',closedAt=?,updatedAt=? WHERE id=? AND status='open'",
      ).run(t, t, row.id);
      res.json({ incident: getIncident(db, row.id) });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get('/api/overview', guard, (req, res) => {
    try {
      const scope = requireIncident(db, req);
      const patients = db
        .prepare(
          'SELECT * FROM patients WHERE incidentId=? AND deletedAt IS NULL ORDER BY length(id),id',
        )
        .all(scope.id)
        .map(jsonPatient);
      const stock = db
        .prepare('SELECT * FROM stock WHERE incidentId=? ORDER BY id')
        .all(scope.id);
      const staffCount = (() => {
        try {
          return db.prepare('SELECT count(*) n FROM staff').get()?.n || 0;
        } catch {
          return 0;
        }
      })();
      res.json({
        incident: scope,
        patients,
        stock,
        staffCount,
        onlineStaffCount: getOnlineCount ? getOnlineCount(scope.id) : 0,
        triageReview: triageReview(db, scope.id),
      });
    } catch (e) {
      sendError(res, e, e.status || 400);
    }
  });
  app.get('/api/patients', guard, (req, res) => {
    try {
      const scope = requireIncident(db, req);
      res.json({
        patients: db
          .prepare(
            'SELECT * FROM patients WHERE incidentId=? AND deletedAt IS NULL ORDER BY length(id),id',
          )
          .all(scope.id)
          .map(jsonPatient),
      });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get('/api/patients/:id', guard, (req, res) => {
    try {
      const scope = requireIncident(db, req);
      const id = normalizeId(req.params.id);
      if (!idOk(id))
        return sendError(
          res,
          Object.assign(new Error('invalid patient id'), { status: 400 }),
        );
      res.json(patientResponse(db, id, scope.id));
    } catch (e) {
      sendError(res, e);
    }
  });
  app.post('/api/patients', guard, (req, res) => {
    try {
      const scope = requireIncident(db, req, true),
        data = req.body || {},
        actor = staffName(req, staffLabel),
        id = normalizeId(data.id),
        result = savePatient(db, {
          scope: scope.id,
          data,
          actor,
          id,
          requestId: req.get('idempotency-key') || data.requestId,
          isEdit: false,
        });
      res.status(result.replay ? 200 : 201).json(result);
    } catch (e) {
      sendError(res, e);
    }
  });
  app.patch('/api/patients/:id', guard, (req, res) => {
    try {
      const scope = requireIncident(db, req, true),
        data = req.body || {},
        id = normalizeId(req.params.id);
      if (!Number.isInteger(data.version))
        throw new Error('version is required');
      res.json(
        savePatient(db, {
          scope: scope.id,
          data,
          actor: staffName(req, staffLabel),
          id,
          version: data.version,
          requestId: req.get('idempotency-key') || data.requestId,
          isEdit: true,
        }),
      );
    } catch (e) {
      sendError(res, e);
    }
  });
  app.delete('/api/patients/:id', guard, (req, res) => {
    try {
      const scope = requireIncident(db, req, true),
        id = normalizeId(req.params.id);
      res.json(
        archivePatient(db, {
          scope: scope.id,
          id,
          version: req.body?.version,
          actor: staffName(req, staffLabel),
        }),
      );
    } catch (e) {
      sendError(res, e);
    }
  });
  app.get('/api/stock', guard, (req, res) => {
    try {
      const s = requireIncident(db, req);
      res.json({
        stock: db
          .prepare('SELECT * FROM stock WHERE incidentId=? ORDER BY id')
          .all(s.id),
      });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.post('/api/stock', guard, (req, res) => {
    try {
      const s = requireIncident(db, req, true),
        { name, category, qty, unit, minAlert } = req.body || {};
      if (
        !name ||
        !category ||
        !unit ||
        !Number.isInteger(qty) ||
        qty < 0 ||
        !Number.isInteger(minAlert) ||
        minAlert < 0
      )
        throw new Error('invalid stock');
      const id = `STK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        t = now();
      db.prepare(
        'INSERT INTO stock (id,name,category,qty,unit,minAlert,updatedAt,staff,incidentId) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        name,
        category,
        qty,
        unit,
        minAlert,
        t,
        staffName(req, staffLabel),
        s.id,
      );
      res.status(201).json({
        stock: db
          .prepare('SELECT * FROM stock WHERE incidentId=? ORDER BY id')
          .all(s.id),
      });
    } catch (e) {
      sendError(res, e);
    }
  });
  app.patch('/api/stock/:id', guard, (req, res) => {
    try {
      const s = requireIncident(db, req, true),
        d = req.body?.delta;
      if (!Number.isInteger(d)) throw new Error('invalid stock');
      db.exec('BEGIN IMMEDIATE');
      const r = db
        .prepare(
          'UPDATE stock SET qty=qty+?,updatedAt=?,staff=? WHERE id=? AND incidentId=? AND qty+?>=0',
        )
        .run(d, now(), staffName(req, staffLabel), req.params.id, s.id, d);
      if (r.changes !== 1)
        throw Object.assign(new Error('stock cannot be negative'), {
          status: 400,
        });
      db.exec('COMMIT');
      res.json({
        stock: db
          .prepare('SELECT * FROM stock WHERE incidentId=? ORDER BY id')
          .all(s.id),
      });
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      sendError(res, e);
    }
  });
  app.post('/api/stock/reset', guard, (req, res) => {
    try {
      const s = requireIncident(db, req, true);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('DELETE FROM stock WHERE incidentId=?').run(s.id);
      const t = now(),
        q = db.prepare(
          'INSERT INTO stock (id,name,category,qty,unit,minAlert,updatedAt,staff,incidentId) VALUES (?,?,?,?,?,?,?,?,?)',
        );
      for (const x of DEFAULT_STOCK)
        q.run(...x, t, staffName(req, staffLabel), s.id);
      db.exec('COMMIT');
      res.json({
        stock: db
          .prepare('SELECT * FROM stock WHERE incidentId=? ORDER BY id')
          .all(s.id),
      });
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      sendError(res, e);
    }
  });
  app.get('/api/qr/:id.png', guard, async (req, res) => {
    try {
      const s = requireIncident(db, req),
        id = normalizeId(req.params.id),
        patient = patientRow(db, id, s.id);
      if (!idOk(id))
        throw Object.assign(new Error('invalid patient id'), { status: 404 });
      if (patient?.deletedAt)
        throw Object.assign(new Error('patient archived'), { status: 410 });
      const origin = publicOrigin || `${req.protocol}://${req.get('host')}`;
      res
        .type('png')
        .send(
          await QRCode.toBuffer(
            `${origin}/?incident=${encodeURIComponent(s.id)}&id=${id}`,
          ),
        );
    } catch (e) {
      sendError(res, e);
    }
  });
}

export { patientResponse, savePatient };
