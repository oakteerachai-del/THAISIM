const assert = require('assert');
(async () => {
  const extras = await import('../public/extras.js');
  const { ERG_SOURCES } = await import('../public/erg-data.js');
  assert.strictEqual(extras.normalizeCardCount(0), 12);
  assert.strictEqual(extras.normalizeCardCount(501), 500);
  assert.strictEqual(extras.normalizeStartCode('42'), 42);
  assert.strictEqual(
    extras.qrImagePath?.('MCI-010', 'exercise-a'),
    '/api/qr/MCI-010.png?incident=exercise-a',
  );
  assert.strictEqual(
    ERG_SOURCES.ios,
    'https://apps.apple.com/th/app/erg4thai/id1514892942',
  );
  assert.strictEqual(
    ERG_SOURCES.android,
    'https://play.google.com/store/apps/details?id=th.pcd.erg',
  );
  assert.strictEqual(
    extras.filterChemicals([{ nameThai: 'คลอรีน', un: '1017' }], '1017').length,
    1,
  );
})();
