const https = require('https');

const TWENTY_BASE = process.env.TWENTY_BASE_URL || 'https://crm.meulucroativo.seg.br';
const TWENTY_KEY = process.env.TWENTY_API_KEY || '';

function _fetch(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/${path}`, TWENTY_BASE);
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${TWENTY_KEY}` },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.statusCode && json.statusCode >= 400) {
            reject(new Error(`Twenty ${json.statusCode}: ${JSON.stringify(json.messages || json.error)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Twenty parse error: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Twenty timeout')); });
  });
}

async function listPage(objectPlural, opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.filter) params.set('filter', opts.filter);
  if (opts.orderBy) params.set('order_by', opts.orderBy);
  if (opts.startingAfter) params.set('starting_after', opts.startingAfter);
  const qs = params.toString();
  const p = qs ? `${objectPlural}?${qs}` : objectPlural;
  const res = await _fetch(p);
  const records = res.data?.[objectPlural] || [];
  const pageInfo = res.pageInfo || {};
  return { records, pageInfo };
}

async function listRecords(objectPlural, opts = {}) {
  const { records } = await listPage(objectPlural, opts);
  return records;
}

async function listAll(objectPlural, opts = {}) {
  const all = [];
  let cursor = null;
  const limit = opts.limit || 60;
  for (let i = 0; i < 20; i++) {
    const params = { ...opts, limit };
    if (cursor) params.startingAfter = cursor;
    const { records, pageInfo } = await listPage(objectPlural, params);
    all.push(...records);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
  return all;
}

async function getRecord(objectPlural, id) {
  const res = await _fetch(`${objectPlural}/${id}`);
  const singular = Object.keys(res.data || {})[0];
  return singular ? res.data[singular] : null;
}

module.exports = { listRecords, listAll, getRecord };
