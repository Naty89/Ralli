// Simple integration script to test /api/rides idempotency.
// Usage: Target a deployed URL and event id via env or CLI:
//   BASE_URL=https://myapp.vercel.app EVENT_ID=<event_id> node scripts/integration/rides-idempotency-test.js
// Or pass args: node scripts/integration/rides-idempotency-test.js https://myapp.vercel.app <event_id>

const BASE = process.env.BASE_URL || process.argv[2] || 'http://localhost:3000';
const eventId = process.env.EVENT_ID || process.argv[3] || '<YOUR_EVENT_ID>'; // set env or pass as arg

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'c_' + Math.random().toString(36).slice(2) + '_' + Date.now();
}

async function postRide(payload) {
  const res = await fetch(`${BASE}/api/rides`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    // leave parsed null and return raw text for debugging
  }
  return { ok: res.ok, status: res.status, body: parsed, raw: text };
}

(async function run() {
  if (eventId === '<YOUR_EVENT_ID>') {
    console.error('Set EVENT_ID env or edit the script to point to a real event id.');
    process.exit(2);
  }

  const clientId = uuid();
  const payload = {
    event_id: eventId,
    rider_name: 'Integration Test',
    rider_phone: '555-000-0000',
    pickup_address: '123 Test St',
    pickup_lat: 40.0,
    pickup_lng: -74.0,
    passenger_count: 1,
    client_id: clientId,
  };

  console.log('Posting first ride...');
  const r1 = await postRide(payload);
  console.log('First response:', r1.status, r1.body && r1.body.data && r1.body.data.id);

  console.log('Posting second (idempotent) ride with same payload...');
  const r2 = await postRide(payload);
  console.log('Second response:', r2.status, r2.body && r2.body.data && r2.body.data.id);

  const id1 = r1.body && r1.body.data && r1.body.data.id;
  const id2 = r2.body && r2.body.data && r2.body.data.id;

  if (!id1 || !id2) {
    console.error('One of the requests failed:', r1, r2);
    process.exit(1);
  }

  if (id1 === id2) {
    console.log('SUCCESS: idempotent behavior observed (same ride id returned).');
    process.exit(0);
  } else {
    console.error('FAIL: different ride ids returned, idempotency failed.');
    process.exit(1);
  }
})();
