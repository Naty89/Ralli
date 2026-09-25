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
const N_DRIVERS = parseInt(arg("drivers", "0"), 10);
const DURATION_S = parseInt(arg("duration", "30"), 10);
const POLL_MS = parseInt(arg("interval", "10000"), 10);
// Spread submissions over this many seconds instead of firing all at once.
// Real arrival is a ramp, not a wall.
const RAMP_S = parseInt(arg("ramp", "0"), 10);
const AUTO_DISPATCH = argv.includes("--auto-dispatch");
const BATCH_MODE = argv.includes("--batch");

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

// created_by is NOT NULL; the scratch event is owned by an approved admin.
// On a clean database there is none yet, so create a throwaway one and remove
// it with the rest of the fixtures.
const temporaryUsers = [];

const { data: existingOwner } = await admin
  .from("profiles")
  .select("id, fraternity_name, organization_code")
  .eq("role", "admin")
  .eq("approval_status", "approved")
  .limit(1)
  .maybeSingle();

let owner = existingOwner;
if (!owner) {
  console.log("No approved admin found; creating a throwaway one for this run.");
  const { data: ownerUser, error: ownerUserError } = await admin.auth.admin.createUser({
    email: `load-owner-${stamp}@ralli.invalid`,
    password: `LoadOwner-${stamp}-safe`,
    email_confirm: true,
  });
  if (ownerUserError || !ownerUser?.user) {
    console.error("could not create a test event owner:", ownerUserError?.message);
    process.exit(1);
  }
  temporaryUsers.push(ownerUser.user.id);
  owner = {
    id: ownerUser.user.id,
    fraternity_name: `Load Test Org ${stamp}`,
    organization_code: `L${String(stamp).slice(-5)}`,
  };
  const { error: ownerProfileError } = await admin.from("profiles").insert({
    id: owner.id,
    role: "admin",
    approval_status: "approved",
    full_name: "Load Test Owner",
    fraternity_name: owner.fraternity_name,
    organization_code: owner.organization_code,
  });
  if (ownerProfileError) {
    console.error("could not create the test owner profile:", ownerProfileError.message);
    await admin.auth.admin.deleteUser(owner.id);
    process.exit(1);
  }
}

const { data: ev, error: evErr } = await admin
  .from("events")
  .insert({
    created_by: owner.id,
    event_name: `LOADTEST ${stamp}`,
    fraternity_name: owner.fraternity_name,
    access_code: `LT${String(stamp).slice(-4)}`,
    // start in the past so the request window is open
    start_time: new Date(Date.now() - 3600_000).toISOString(),
    end_time: new Date(Date.now() + 3600_000).toISOString(),
    is_active: true,
    auto_dispatch_enabled: AUTO_DISPATCH,
    batch_mode_enabled: BATCH_MODE,
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
  if (N_DRIVERS > 0) {
    console.log(`Creating ${N_DRIVERS} temporary approved drivers...`);
    for (let i = 0; i < N_DRIVERS; i++) {
      const email = `load-${stamp}-${i}@ralli.invalid`;
      const password = `LoadTest-${stamp}-${i}-safe`;
      const { data: userData, error: userError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (userError || !userData?.user) throw new Error(userError?.message ?? "driver user creation failed");
      temporaryUsers.push(userData.user.id);

      const { error: profileError } = await admin.from("profiles").insert({
        id: userData.user.id,
        role: "driver",
        approval_status: "approved",
        full_name: `Load Driver ${i}`,
        fraternity_name: owner.fraternity_name,
        organization_code: owner.organization_code,
      });
      if (profileError) throw new Error(profileError.message);

      const { error: driverError } = await admin.from("drivers").insert({
        event_id: eventId,
        profile_id: userData.user.id,
        is_online: true,
        current_status: "available",
        current_lat: 42.7,
        current_lng: -73.8,
        max_capacity: 4,
        current_passenger_load: 0,
      });
      if (driverError) throw new Error(driverError.message);
    }
  }

  // --- phase 1: concurrent ride submissions ---------------------------------
  // 10 digits, unique per simulated rider.
  // --same-phone simulates one rider double-tapping submit (worst case for
  // the rate limiter, which used to 500 on every later request).
  const samePhone = argv.includes("--same-phone");
  const phone = (i) =>
    samePhone ? "555" + String(1000000).slice(-7) : "555" + String(1000000 + i).slice(-7);

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
      return json.data?.id
        ? { id: json.data.id, accessToken: json.access_token }
        : null;
    } catch (err) {
      createFail.network = (createFail.network || 0) + 1;
      return null;
    }
  };

  console.log(`Phase 1: ${N_RIDES} concurrent ride submissions...`);
  const t1 = Date.now();
  const delay = RAMP_S > 0 ? (RAMP_S * 1000) / N_RIDES : 0;
  const created = (
    await Promise.all(
      Array.from({ length: N_RIDES }, async (_, i) => {
        if (delay) await new Promise((r) => setTimeout(r, delay * i));
        const ride = await createOne(i);
        return ride ? { ...ride, phone: phone(i) } : null;
      })
    )
  ).filter(Boolean);
  console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  created: ${createOk.count}/${N_RIDES}`);
  if (Object.keys(createFail).length) console.log(`  failures:`, createFail);
  if (createSamples.length) console.log(`  sample errors:`);
  for (const e of createSamples) console.log(`    - ${String(e).slice(0, 200)}`);
  console.log(`  latency ms:`, stats(createTimes));

  if (AUTO_DISPATCH) {
    const { count: assignedCount } = await admin
      .from("ride_requests")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("status", "assigned");
    console.log(`  assigned by auto-dispatch: ${assignedCount ?? 0}`);

    // Dispatch consistency audit. Concurrent dispatch loops previously could
    // claim two drivers for one ride, or leave a driver marked assigned with
    // seats reserved for a ride that named someone else. Counting assignments
    // is not enough - the ride, driver and seat accounting must agree.
    const { data: auditRides } = await admin
      .from("ride_requests")
      .select("id, status, assigned_driver_id, passenger_count")
      .eq("event_id", eventId);
    const { data: auditDrivers } = await admin
      .from("drivers")
      .select("id, current_status, current_passenger_load, max_capacity")
      .eq("event_id", eventId);

    const problems = [];
    const loadByDriver = new Map();
    for (const ride of auditRides ?? []) {
      if (!["assigned", "arrived", "in_progress"].includes(ride.status)) continue;
      if (!ride.assigned_driver_id) {
        problems.push(`ride ${ride.id} is ${ride.status} with no driver`);
        continue;
      }
      loadByDriver.set(
        ride.assigned_driver_id,
        (loadByDriver.get(ride.assigned_driver_id) ?? 0) + (ride.passenger_count || 0)
      );
    }

    for (const driver of auditDrivers ?? []) {
      const realLoad = loadByDriver.get(driver.id) ?? 0;
      if (driver.current_passenger_load !== realLoad) {
        problems.push(
          `driver ${driver.id} records load ${driver.current_passenger_load} but holds ${realLoad}`
        );
      }
      if (realLoad > driver.max_capacity) {
        problems.push(`driver ${driver.id} over capacity: ${realLoad}/${driver.max_capacity}`);
      }
      const shouldBeAssigned = realLoad > 0;
      if (shouldBeAssigned && driver.current_status !== "assigned") {
        problems.push(`driver ${driver.id} holds ${realLoad} rider(s) but is ${driver.current_status}`);
      }
      if (!shouldBeAssigned && driver.current_status === "assigned") {
        problems.push(`driver ${driver.id} is assigned with no active ride (seats stranded)`);
      }
    }

    if (problems.length === 0) {
      console.log(`  dispatch consistency: OK (${loadByDriver.size} driver(s) holding riders)`);
    } else {
      console.log(`  dispatch consistency: ${problems.length} PROBLEM(S)`);
      for (const problem of problems.slice(0, 10)) console.log(`    - ${problem}`);
    }
  }

  // --- phase 2: concurrent polling ------------------------------------------
  if (created.length === 0) {
    console.log("\nNo rides to poll - stopping.");
  } else {
    const pollers = created.slice(0, Math.min(N_POLLERS, created.length));
    const pollTimes = [];
    let pollOk = 0;
    const pollFail = {};
    const pollSamples = [];
    let stop = false;

    const pollLoop = async ({ id, accessToken }) => {
      while (!stop) {
        const t0 = performance.now();
        try {
          const res = await fetch(`${BASE}/api/rides/${id}`, {
            headers: { "X-Ralli-Ride-Token": accessToken },
          });
          pollTimes.push(performance.now() - t0);
          if (res.ok) pollOk++;
          else {
            pollFail[res.status] = (pollFail[res.status] || 0) + 1;
            if (pollSamples.length < 5) pollSamples.push(`${res.status}: ${(await res.text()).slice(0, 200)}`);
          }
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
    for (const sample of pollSamples) console.log(`    sample: ${sample}`);
    console.log(`  latency ms:`, stats(pollTimes));
  }
} finally {
  // --- cleanup ---------------------------------------------------------------
  console.log("\nCleaning up...");
  const { data: batches } = await admin.from("ride_batches").select("id").eq("event_id", eventId);
  for (const batch of batches ?? []) {
    await admin.from("ride_batch_items").delete().eq("batch_id", batch.id);
  }
  await admin.from("ride_requests").delete().eq("event_id", eventId);
  await admin.from("ride_batches").delete().eq("event_id", eventId);
  await admin.from("rider_rate_limits").delete().eq("event_id", eventId);
  await admin.from("rider_consents").delete().eq("event_id", eventId);
  await admin.from("rider_penalties").delete().eq("event_id", eventId);
  await admin.from("dispatch_event_locks").delete().eq("event_id", eventId);
  await admin.from("drivers").delete().eq("event_id", eventId);
  await admin.from("events").delete().eq("id", eventId);
  for (const id of temporaryUsers) {
    await admin.from("profiles").delete().eq("id", id);
    await admin.auth.admin.deleteUser(id);
  }
  console.log("Test event and all test rides removed.\n");
}
