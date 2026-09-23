// Load-test the live rider API.
//
// Creates a throwaway event, fires N concurrent ride submissions, then has M
// simulated riders poll at the real interval, then deletes everything.
//
// Usage:
//   node scripts/load-test.mjs                       # 100 rides, 50 pollers, 30s
//   node scripts/load-test.mjs --rides=300 --pollers=150 --duration=30
//   node scripts/load-test.mjs --url=https://ralli-gamma.vercel.app

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : dflt;
};

const BASE = arg("url", "https://ralli-gamma.vercel.app");
const N_RIDES = parseInt(arg("rides", "100"), 10);
const N_POLLERS = parseInt(arg("pollers", "50"), 10);
const DURATION_S = parseInt(arg("duration", "30"), 10);
const POLL_MS = parseInt(arg("interval", "10000"), 10);

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function stats(times) {
  if (times.length === 0) return { n: 0 };
  const s = [...times].sort((a, b) => a - b);
  const p = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))]);
  return {
    n: s.length,
    p50: p(0.5),
    p95: p(0.95),
    max: Math.round(s[s.length - 1]),
  };
}

// --- setup: throwaway event -------------------------------------------------
const stamp = Date.now();

// created_by is NOT NULL, so borrow an existing profile as the owner.
const { data: owner } = await admin.from("profiles").select("id").limit(1).maybeSingle();
if (!owner) {
  console.error("no profile found to own the test event");
  process.exit(1);
}

const { data: ev, error: evErr } = await admin
  .from("events")
  .insert({
    created_by: owner.id,
    event_name: `LOADTEST ${stamp}`,
    fraternity_name: "LOADTEST",
    access_code: `LT${String(stamp).slice(-4)}`,
    // start in the past so the request window is open
    start_time: new Date(Date.now() - 3600_000).toISOString(),
    end_time: new Date(Date.now() + 3600_000).toISOString(),
    is_active: true,
    auto_dispatch_enabled: false,
    batch_mode_enabled: false,
  })
  .select("id")
  .single();

if (evErr || !ev) {
  console.error("could not create test event:", evErr?.message);
  process.exit(1);
}
const eventId = ev.id;
console.log(`\nTest event ${eventId} on ${BASE}\n`);

try {
  // --- phase 1: concurrent ride submissions ---------------------------------
  // 10 digits, unique per simulated rider
  const phone = (i) => "555" + String(1000000 + i).slice(-7);

  const createTimes = [];
  const createOk = { count: 0 };
  const createFail = {};
  const createSamples = [];

  const createOne = async (i) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}/api/rides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          rider_name: `Load Rider ${i}`,
          rider_phone: phone(i),
          pickup_address: `${i} Test St`,
          pickup_lat: 42.7 + i * 0.0001,
          pickup_lng: -73.8 + i * 0.0001,
          passenger_count: 1,
          client_id: `loadtest-${stamp}-${i}`,
        }),
      });
      createTimes.push(performance.now() - t0);
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.data) createOk.count++;
      else {
        createFail[res.status] = (createFail[res.status] || 0) + 1;
        if (json.error && createSamples.length < 5) createSamples.push(json.error);
      }
      return json.data?.id ?? null;
    } catch (err) {
      createFail.network = (createFail.network || 0) + 1;
      return null;
    }
  };

  console.log(`Phase 1: ${N_RIDES} concurrent ride submissions...`);
  const t1 = Date.now();
  const created = (
    await Promise.all(
      Array.from({ length: N_RIDES }, async (_, i) => {
        const id = await createOne(i);
        return id ? { id, phone: phone(i) } : null;
      })
    )
  ).filter(Boolean);
  console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  created: ${createOk.count}/${N_RIDES}`);
  if (Object.keys(createFail).length) console.log(`  failures:`, createFail);
  if (createSamples.length) console.log(`  sample errors:`);
  for (const e of createSamples) console.log(`    - ${String(e).slice(0, 200)}`);
  console.log(`  latency ms:`, stats(createTimes));

  // --- phase 2: concurrent polling ------------------------------------------
  if (created.length === 0) {
    console.log("\nNo rides to poll - stopping.");
  } else {
    const pollers = created.slice(0, Math.min(N_POLLERS, created.length));
    const pollTimes = [];
    let pollOk = 0;
    const pollFail = {};
    let stop = false;

    const pollLoop = async ({ id, phone: p }) => {
      while (!stop) {
        const t0 = performance.now();
        try {
          const res = await fetch(`${BASE}/api/rides/${id}?rider_phone=${p}`);
          pollTimes.push(performance.now() - t0);
          if (res.ok) pollOk++;
          else pollFail[res.status] = (pollFail[res.status] || 0) + 1;
        } catch {
          pollFail.network = (pollFail.network || 0) + 1;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    };

    console.log(`\nPhase 2: ${pollers.length} riders polling every ${POLL_MS / 1000}s for ${DURATION_S}s...`);
    const t2 = Date.now();
    const loops = pollers.map((entry) => pollLoop(entry));
    await new Promise((r) => setTimeout(r, DURATION_S * 1000));
    stop = true;
    await Promise.all(loops);
    const elapsed = (Date.now() - t2) / 1000;

    console.log(`  requests: ${pollOk} ok in ${elapsed.toFixed(0)}s  (${(pollOk / elapsed).toFixed(1)} req/s)`);
    if (Object.keys(pollFail).length) console.log(`  failures:`, pollFail);
    else console.log(`  failures: none`);
    console.log(`  latency ms:`, stats(pollTimes));
  }
} finally {
  // --- cleanup ---------------------------------------------------------------
  console.log("\nCleaning up...");
  await admin.from("ride_requests").delete().eq("event_id", eventId);
  await admin.from("rider_rate_limits").delete().eq("event_id", eventId);
  await admin.from("rider_consents").delete().eq("event_id", eventId);
  await admin.from("events").delete().eq("id", eventId);
  console.log("Test event and all test rides removed.\n");
}
