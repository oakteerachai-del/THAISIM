import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const script = readFileSync(
  new URL('../integrations/google-sheets.gs', import.meta.url),
  'utf8',
);
const syntheticRow = (incidentId) => ({
  id: 'MCI-010',
  incidentId,
  version: 1,
  color: 'green',
  zone: 'triage',
  interventions: [],
});

function fakeSheet(headers) {
  const grid = [[...headers]];
  return {
    grid,
    getLastRow: () => grid.length,
    getMaxRows: () => 1000,
    getRange(row = 1, column = 1, rowCount = 1, width = 1) {
      const at = (position) => (grid[position] ??= []);
      return {
        getValues: () =>
          Array.from({ length: rowCount }, (_, offset) =>
            Array.from(
              { length: width },
              (_, c) => grid[row + offset - 1]?.[column + c - 1] ?? '',
            ),
          ),
        setValue: (value) => {
          at(row - 1)[column - 1] = value;
        },
        setValues: (rows) =>
          rows.forEach((cells, offset) =>
            cells.forEach((value, c) => {
              at(row + offset - 1)[column + c - 1] = value;
            }),
          ),
        clearContent() {
          for (let r = 0; r < rowCount; r += 1) {
            for (let c = 0; c < width; c += 1)
              at(row + r - 1)[column + c - 1] = '';
          }
        },
      };
    },
  };
}

function rehearsal() {
  const records = new Map(
    ['first', 'second'].map((id) => [id + ':MCI-010', syntheticRow(id)]),
  );
  const receipts = new Map();
  const sheets = {};
  let dropReply = false;
  const context = createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (name) =>
          ({
            THAISIM_SPREADSHEET_ID: 'test-sheet',
            THAISIM_SYNC_TOKEN: 'fixture-token',
          })[name],
      }),
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (name) => sheets[name] }),
      flush: () => {},
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, value) =>
        createHash(algorithm).update(value).digest(),
      base64EncodeWebSafe: (bytes) => bytes.toString('base64url'),
      getUuid: randomUUID,
    },
    UrlFetchApp: {
      fetch(url, options) {
        const body = JSON.parse(options.payload || 'null');
        let data = {};
        if (url.endsWith('/snapshot')) {
          data = {
            patients: [...records.values()],
            accounts: [],
            incidents: ['first', 'second'].map((id) => ({ id, name: id })),
          };
        } else if (url.endsWith('/changes')) {
          if (!receipts.has(body.requestId)) {
            const row = body.patients[0];
            const key = row.incidentId + ':' + (row.id || 'MCI-011');
            let record;
            if (row.Action === 'DELETE') records.delete(key);
            else {
              record = {
                ...records.get(key),
                ...row,
                id: row.id || 'MCI-011',
                entityId: key,
                version: (records.get(key)?.version || 0) + 1,
              };
              records.set(key, record);
            }
            receipts.set(body.requestId, {
              applied: { patients: [{ action: row.Action, id: key, record }] },
            });
          }
          data = receipts.get(body.requestId);
          if (dropReply) {
            dropReply = false;
            throw new Error('response lost');
          }
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(data),
        };
      },
    },
  });
  runInContext(script, context);
  sheets['ผู้ป่วย'] = fakeSheet(context.PH);
  sheets['เจ้าหน้าที่'] = fakeSheet(context.AH);
  sheets['เหตุการณ์'] = fakeSheet(context.IH);
  return {
    records,
    receipts,
    patients: sheets['ผู้ป่วย'],
    sync: () => context.syncThaiSimNow(),
    dropNextReply: () => {
      dropReply = true;
    },
  };
}

test('Google Sheets reads scoped rows and applies edits and deletion only to the selected ID', () => {
  const trial = rehearsal();
  trial.sync();
  assert.equal(trial.patients.grid[1][4], 'เขียว');
  trial.patients.getRange(2, 5).setValue('แดง');
  trial.sync();
  assert.equal(trial.records.get('first:MCI-010').color, 'red');
  assert.equal(trial.records.get('second:MCI-010').color, 'green');
  trial.patients.getRange(2, 1).setValue('ลบ');
  trial.sync();
  assert.equal(trial.records.has('first:MCI-010'), false);
  assert.equal(trial.records.has('second:MCI-010'), true);
  assert.equal(trial.patients.grid[1][2], '');
});

test('a lost reply preserves one new request and one generated patient row', () => {
  const trial = rehearsal();
  trial.sync();
  trial.patients
    .getRange(4, 1, 1, 6)
    .setValues([['เพิ่ม', '', '', 'first', 'เขียว', 'จุดคัดแยก']]);
  trial.dropNextReply();
  trial.sync();
  assert.equal(trial.records.has('first:MCI-011'), true);
  trial.sync();
  assert.equal(trial.receipts.size, 1);
  assert.equal(
    trial.patients.grid.filter((row) => row[2] === 'MCI-011').length,
    1,
  );
  assert.equal(trial.patients.grid[3][2], 'MCI-011');
});
