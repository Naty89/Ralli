// Verify the live RLS/grant configuration with real fixture rows present.
//
// The mistake this script exists to prevent: during the incident response an
// anonymous read of an EMPTY `drivers` table returned zero rows and was read as
// proof the policy was safe. It was not - a public SELECT policy was still
// there. So this script creates an organization, an event, an approved driver
// with a driver row, a pending driver, and an assigned ride, and only then
// checks what each role can see and do.
//
// It creates everything with the service role, asserts against it with the anon
// key (plus real sessions), and removes it all in a finally block.
//
// Usage: node scripts/verify-rls-authenticated.mjs

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const newAnonClient = () =>
  createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

const stamp = Date.now();
const tag = `rlsverify-${stamp}`;
const ORG = `RLS Verify Org ${stamp}`;
const ORG_CODE = `V${String(stamp).slice(-5)}`;

let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

// A write that must be refused. PostgREST reports a blocked write either as an
// error or as "0 rows affected", so both count as refusal.
async function mustBeRefused(label, query) {
  const { data, error } = await query;
  const refused = Boolean(error) || !data || (Array.isArray(data) && data.length === 0);
  check(label, refused, error ? `${error.code ?? ""} ${error.message}`.trim() : refused ? "0 rows affected" : "WRITE SUCCEEDED");
}

async function mustSucceed(label, query) {
  const { data, error } = await query;
  const ok = !error && data && (!Array.isArray(data) || data.length > 0);
  check(label, ok, error ? `${error.code ?? ""} ${error.message}`.trim() : ok ? "" : "no rows returned");
}

const created = { users: [], eventId: null };

async function makeUser(email, profile) {
  const password = `V3rify-${Math.random().toString(36).slice(2)}-Xy9`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data?.user) throw new Error(`createUser(${email}): ${error?.message}`);
  created.users.push(data.user.id);
  const { error: profileError } = await admin.from("profiles").insert({ id: data.user.id, ...profile });
  if (profileError) throw new Error(`profile(${email}): ${profileError.message}`);
  return { id: data.user.id, email, password };
}

try {
  console.log(`\nBuilding fixtures (org="${ORG}", code=${ORG_CODE})\n`);

  const orgAdmin = await makeUser(`${tag}-admin@ralli.invalid`, {
    role: "admin",
    approval_status: "approved",
    full_name: "Verify Admin",
    fraternity_name: ORG,
    organization_code: ORG_CODE,
  });

  const approvedDriver = await makeUser(`${tag}-driver@ralli.invalid`, {
    role: "driver",
    approval_status: "approved",
    full_name: "Verify Approved Driver",
    fraternity_name: ORG,
    organization_code: ORG_CODE,
  });

  const pendingDriver = await makeUser(`${tag}-pending@ralli.invalid`, {
    role: "driver",
    approval_status: "pending",
    full_name: "Verify Pending Driver",
    fraternity_name: ORG,
    organization_code: ORG_CODE,
  });

  // A second organization, to prove cross-organization reads are blocked.
  const otherAdmin = await makeUser(`${tag}-other@ralli.invalid`, {
    role: "admin",
    approval_status: "approved",
    full_name: "Verify Other Admin",
    fraternity_name: `${ORG} OTHER`,
    organization_code: `O${String(stamp).slice(-5)}`,
  });

  const { data: event, error: eventError } = await admin
    .from("events")
    .insert({
      fraternity_name: ORG,
      event_name: `Verify Event ${stamp}`,
      access_code: `V${String(stamp).slice(-5)}`,
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      is_active: true,
      created_by: orgAdmin.id,
    })
    .select("id")
    .single();
  if (eventError) throw new Error(`event: ${eventError.message}`);
  created.eventId = event.id;

  const { data: driverRow, error: driverRowError } = await admin
    .from("drivers")
    .insert({
      event_id: event.id,
      profile_id: approvedDriver.id,
      is_online: true,
      current_status: "assigned",
      current_lat: 40.0,
      current_lng: -74.0,
      max_capacity: 4,
      current_passenger_load: 3,
    })
    .select("id")
    .single();
  if (driverRowError) throw new Error(`driver row: ${driverRowError.message}`);

  // Two rides assigned to that driver: a two-stop batch in progress. Completing
  // one leaves the driver holding the other, which is the case that must be
  // allowed to recompute a NON-ZERO passenger load.
  const rideRows = [1, 2].map((n) => ({
    event_id: event.id,
    rider_name: `Verify Rider ${n}`,
    rider_phone: "5550000000",
    pickup_address: `${n} Verify St`,
    pickup_lat: 40.001 * n,
    pickup_lng: -74.001 * n,
    passenger_count: n === 1 ? 1 : 2,
    status: "assigned",
    assigned_driver_id: driverRow.id,
  }));
  const { data: rides, error: rideError } = await admin.from("ride_requests").insert(rideRows).select("id");
  if (rideError) throw new Error(`rides: ${rideError.message}`);

  console.log("Fixtures ready: 1 event, 1 driver row (load 3), 2 assigned rides\n");

  // ---------------------------------------------------------------- anonymous
  console.log("Anonymous (public anon key), with driver and ride rows present:");
  const anon = newAnonClient();
  for (const table of [
    "profiles",
    "drivers",
    "events",
    "ride_requests",
    "ride_batches",
    "ride_batch_items",
    "emergency_events",
    "rider_penalties",
    "rider_consents",
    "rider_rate_limits",
    "api_rate_limits",
    "dispatch_event_locks",
  ]) {
    const { data, error } = await anon.from(table).select("*").limit(5);
    const rows = (data ?? []).length;
    // Require denial at the GRANT level (42501), not merely an empty result.
    // A table that returns zero rows is relying on its policies alone, so
    // disabling RLS on it would re-expose every row.
    check(
      `anon denied on ${table} at grant level`,
      error?.code === "42501",
      error ? `${error.code} ${error.message}` : `readable, ${rows} row(s) returned`
    );
  }

  await mustBeRefused(
    "anon cannot insert a profile (role escalation)",
    anon.from("profiles").insert({ id: crypto.randomUUID(), role: "admin", full_name: "x", fraternity_name: ORG }).select("id")
  );

  // ------------------------------------------------------------- event admin
  console.log("\nEvent admin (own organization):");
  const adminSession = newAnonClient();
  {
    const { error } = await adminSession.auth.signInWithPassword({ email: orgAdmin.email, password: orgAdmin.password });
    if (error) throw new Error(`admin sign in: ${error.message}`);
  }

  await mustSucceed("admin reads own event", adminSession.from("events").select("id").eq("id", event.id));
  await mustSucceed("admin reads drivers for own event", adminSession.from("drivers").select("id").eq("event_id", event.id));
  await mustSucceed("admin reads rides for own event", adminSession.from("ride_requests").select("id").eq("event_id", event.id));
  await mustSucceed(
    "admin performs the dashboard drivers->profiles join",
    adminSession.from("drivers").select("id, profile:profiles(full_name)").eq("event_id", event.id)
  );
  await mustSucceed(
    "admin lists approved drivers in own organization",
    adminSession
      .from("profiles")
      .select("id")
      .eq("role", "driver")
      .eq("approval_status", "approved")
      .eq("organization_code", ORG_CODE)
  );

  {
    const { data } = await adminSession.from("profiles").select("id").eq("id", otherAdmin.id);
    check("admin cannot read another organization's profile", (data ?? []).length === 0, `${(data ?? []).length} row(s)`);
  }

  await mustBeRefused(
    "admin cannot promote themselves or edit a profile",
    adminSession.from("profiles").update({ full_name: "escalated" }).eq("id", orgAdmin.id).select("id")
  );
  await mustBeRefused(
    "admin cannot add the PENDING driver to the event",
    adminSession.from("drivers").insert({ event_id: event.id, profile_id: pendingDriver.id }).select("id")
  );

  // ------------------------------------------------------------------ driver
  console.log("\nApproved driver (own row):");
  const driverSession = newAnonClient();
  {
    const { error } = await driverSession.auth.signInWithPassword({
      email: approvedDriver.email,
      password: approvedDriver.password,
    });
    if (error) throw new Error(`driver sign in: ${error.message}`);
  }

  await mustSucceed("driver reads own driver row", driverSession.from("drivers").select("id").eq("id", driverRow.id));
  await mustSucceed("driver reads assigned rides", driverSession.from("ride_requests").select("id").eq("assigned_driver_id", driverRow.id));
  await mustSucceed(
    "driver updates own GPS location",
    driverSession.from("drivers").update({ current_lat: 40.5, current_lng: -74.5 }).eq("id", driverRow.id).select("id")
  );

  await mustBeRefused(
    "driver cannot move own row to another event",
    driverSession.from("drivers").update({ event_id: created.eventId, profile_id: otherAdmin.id }).eq("id", driverRow.id).select("id")
  );
  await mustBeRefused(
    "driver cannot raise own vehicle capacity",
    driverSession.from("drivers").update({ max_capacity: 99 }).eq("id", driverRow.id).select("id")
  );
  await mustBeRefused(
    "driver cannot zero out seat load while holding riders",
    driverSession.from("drivers").update({ current_passenger_load: 0 }).eq("id", driverRow.id).select("id")
  );
  await mustBeRefused(
    "driver cannot invent spare capacity",
    driverSession.from("drivers").update({ current_passenger_load: 1 }).eq("id", driverRow.id).select("id")
  );
  await mustBeRefused(
    "driver cannot go available while rides are active",
    driverSession
      .from("drivers")
      .update({ current_status: "available", is_online: true })
      .eq("id", driverRow.id)
      .select("id")
  );
  await mustBeRefused(
    "driver cannot edit own profile row",
    driverSession.from("profiles").update({ full_name: "renamed" }).eq("id", approvedDriver.id).select("id")
  );
  await mustBeRefused(
    "driver cannot read the whole drivers table",
    driverSession.from("drivers").select("id").neq("id", driverRow.id)
  );

  // The regression this suite exists for: completing one stop of a two-stop
  // batch recomputes a non-zero load, which must be allowed.
  console.log("\nBatch completion (one stop of two):");
  await mustSucceed(
    "driver completes the first ride",
    driverSession
      .from("ride_requests")
      .update({ status: "completed", completion_timestamp: new Date().toISOString() })
      .eq("id", rides[0].id)
      .select("id")
  );
  await mustSucceed(
    "driver recomputes seat load to the still-assigned 2 riders",
    driverSession.from("drivers").update({ current_passenger_load: 2 }).eq("id", driverRow.id).select("id")
  );
  await mustSucceed(
    "driver completes the second ride",
    driverSession
      .from("ride_requests")
      .update({ status: "completed", completion_timestamp: new Date().toISOString() })
      .eq("id", rides[1].id)
      .select("id")
  );
  await mustSucceed(
    "driver goes available once nothing is assigned",
    driverSession
      .from("drivers")
      .update({ current_status: "available", is_online: true, current_passenger_load: 0 })
      .eq("id", driverRow.id)
      .select("id")
  );

  // ---------------------------------------------------- cross-organization
  console.log("\nOther organization's admin:");
  const otherSession = newAnonClient();
  {
    const { error } = await otherSession.auth.signInWithPassword({ email: otherAdmin.email, password: otherAdmin.password });
    if (error) throw new Error(`other admin sign in: ${error.message}`);
  }
  for (const [label, query] of [
    ["cannot read the event", otherSession.from("events").select("id").eq("id", event.id)],
    ["cannot read its drivers", otherSession.from("drivers").select("id").eq("event_id", event.id)],
    ["cannot read its rides", otherSession.from("ride_requests").select("id").eq("event_id", event.id)],
  ]) {
    const { data, error } = await query;
    check(`other-org admin ${label}`, Boolean(error) || (data ?? []).length === 0, error ? error.code : `${(data ?? []).length} row(s)`);
  }
  await mustBeRefused(
    "other-org admin cannot reassign a driver",
    otherSession.from("drivers").update({ current_status: "offline", is_online: false }).eq("id", driverRow.id).select("id")
  );
} catch (err) {
  failed++;
  console.error(`\nSETUP ERROR: ${err.message}`);
} finally {
  console.log("\nRemoving fixtures...");
  if (created.eventId) {
    await admin.from("ride_requests").delete().eq("event_id", created.eventId);
    await admin.from("drivers").delete().eq("event_id", created.eventId);
    await admin.from("dispatch_event_locks").delete().eq("event_id", created.eventId);
    await admin.from("events").delete().eq("id", created.eventId);
  }
  for (const id of created.users) {
    await admin.from("profiles").delete().eq("id", id);
    await admin.auth.admin.deleteUser(id);
  }
  console.log(`Fixtures removed.\n\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}
