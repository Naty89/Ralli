// Forensic sweep: find the accounts and rows the attacker touched.
// Read-only - prints findings, deletes nothing.
//
// Usage: node scripts/find-suspicious.mjs

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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const users = [];
let page = 1;
while (true) {
  const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  users.push(...(data?.users ?? []));
  if (!data?.users || data.users.length < 200) break;
  page++;
  if (page > 50) break;
}
const emailById = new Map(users.map((u) => [u.id, u.email]));
const createdById = new Map(users.map((u) => [u.id, u.created_at]));

console.log("\n=== 1. Profiles with a suspicious display name ===");
const { data: named } = await admin
  .from("profiles")
  .select("id, role, full_name, organization_code, created_at")
  .or("full_name.ilike.%netanyahu%,full_name.ilike.%benjamin%,full_name.ilike.%bibi%");

if (!named || named.length === 0) {
  console.log("  none found (rows may already have been cleaned up)");
} else {
  for (const p of named) {
    console.log(
      `  ${(emailById.get(p.id) ?? "(deleted)").padEnd(30)} name="${p.full_name}" role=${p.role} org=${p.organization_code ?? "-"} created=${(p.created_at ?? createdById.get(p.id) ?? "").slice(0, 10)}`
    );
  }
}

console.log("\n=== 2. Drivers pinned to Tel Aviv (lat 31.9-32.4, lng 34.6-35.1) ===");
const { data: taDrivers } = await admin
  .from("drivers")
  .select("id, event_id, profile_id, current_lat, current_lng, current_status");

const telAviv = (taDrivers ?? []).filter(
  (d) =>
    d.current_lat !== null &&
    d.current_lng !== null &&
    d.current_lat > 31.9 && d.current_lat < 32.4 &&
    d.current_lng > 34.6 && d.current_lng < 35.1
);

if (telAviv.length === 0) {
  console.log("  none found");
} else {
  for (const d of telAviv) {
    console.log(`  driver=${d.id} profile=${d.profile_id} lat=${d.current_lat} lng=${d.current_lng} email=${emailById.get(d.profile_id) ?? "?"}`);
  }
}

console.log("\n=== 3. All admin accounts, newest first ===");
const { data: admins } = await admin
  .from("profiles")
  .select("id, full_name, organization_code, created_at")
  .eq("role", "admin")
  .order("created_at", { ascending: false });

for (const p of admins ?? []) {
  const created = (p.created_at ?? createdById.get(p.id) ?? "").slice(0, 16);
  console.log(`  ${(emailById.get(p.id) ?? "(deleted)").padEnd(30)} name="${p.full_name}" org=${p.organization_code ?? "-"} created=${created}`);
}

console.log("\n=== 4. Can the PUBLIC anon key read these tables? ===");
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

for (const t of ["profiles", "events", "drivers", "ride_requests", "rider_penalties", "rider_rate_limits"]) {
  const { data, error } = await anon.from(t).select("*").limit(1);
  if (error) {
    console.log(`  ${t.padEnd(20)} BLOCKED (${error.code}) :: ${error.message}`);
  } else if (data && data.length > 0) {
    console.log(`  ${t.padEnd(20)} *** READABLE BY ANYONE *** sample keys: ${Object.keys(data[0]).slice(0, 8).join(",")}`);
  } else {
    console.log(`  ${t.padEnd(20)} no rows returned (RLS filtered, or empty)`);
  }
}

console.log("\n=== 5. Events and their owner ===");
const { data: events } = await admin
  .from("events")
  .select("id, event_name, access_code, created_by, start_time, is_active")
  .order("created_at", { ascending: false });

for (const e of events ?? []) {
  console.log(`  ${e.event_name} [${e.access_code}] owner=${emailById.get(e.created_by) ?? "?"} active=${e.is_active} start=${(e.start_time ?? "").slice(0, 10)}`);
}
console.log();
