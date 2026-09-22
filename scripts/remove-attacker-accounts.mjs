// Remove the accounts the attacker registered, plus the event they created.
//
// Targets:
//   1. every profile whose display name is "Benjamin Netanyahu"
//   2. the attacker's self-registered admin account (see ATTACKER_EMAILS)
//
// Usage:
//   node scripts/remove-attacker-accounts.mjs          # dry run
//   node scripts/remove-attacker-accounts.mjs --apply  # actually delete

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

const apply = process.argv.includes("--apply");
const ATTACKER_EMAILS = new Set(["megopo9268@newtrea.com"]);

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

const { data: renamed } = await admin
  .from("profiles")
  .select("id, role, full_name, organization_code")
  .or("full_name.ilike.%netanyahu%,full_name.ilike.%bibi%");

const targets = [...(renamed ?? [])];
for (const u of users) {
  if (u.email && ATTACKER_EMAILS.has(u.email.toLowerCase())) {
    if (!targets.find((t) => t.id === u.id)) {
      targets.push({ id: u.id, role: "admin", full_name: "(attacker admin)", organization_code: null });
    }
  }
}

console.log(`\n${targets.length} account(s) targeted\n`);
for (const t of targets) {
  console.log(`  ${t.id}  ${(emailById.get(t.id) ?? "(no auth user)").padEnd(30)} role=${t.role} name="${t.full_name}"`);
}

// Events owned by any target (attacker's own admin account).
const { data: ownedEvents } = await admin
  .from("events")
  .select("id, event_name, access_code, created_by");
const owned = (ownedEvents ?? []).filter((e) => targets.find((t) => t.id === e.created_by));

if (owned.length) {
  console.log(`\n${owned.length} event(s) owned by targets:`);
  for (const e of owned) console.log(`  ${e.event_name} [${e.access_code}] ${e.id}`);
}

if (!apply) {
  console.log("\nDRY RUN - nothing deleted. Re-run with --apply.\n");
  process.exit(0);
}

console.log("\nDeleting...\n");

for (const e of owned) {
  const { data: batches } = await admin.from("ride_batches").select("id").eq("event_id", e.id);
  for (const b of batches ?? []) {
    await admin.from("ride_batch_items").delete().eq("batch_id", b.id);
  }
  await admin.from("ride_batches").delete().eq("event_id", e.id);
  await admin.from("ride_requests").delete().eq("event_id", e.id);
  await admin.from("emergency_events").delete().eq("event_id", e.id);
  await admin.from("rider_consents").delete().eq("event_id", e.id);
  await admin.from("rider_penalties").delete().eq("event_id", e.id);
  await admin.from("drivers").delete().eq("event_id", e.id);
  const { error } = await admin.from("events").delete().eq("id", e.id);
  console.log(`  event ${e.event_name} [${e.access_code}]: ${error ? "FAILED " + error.message : "deleted"}`);
}

for (const t of targets) {
  // Remove driver assignment rows first (drivers.profile_id -> profiles.id)
  await admin.from("drivers").delete().eq("profile_id", t.id);
  await admin.from("profiles").delete().eq("id", t.id);
  const { error } = await admin.auth.admin.deleteUser(t.id);
  const email = emailById.get(t.id) ?? "(no auth user)";
  console.log(`  ${email}: ${error ? "auth delete failed - " + error.message : "deleted"}`);
}

console.log("\nDone.\n");
