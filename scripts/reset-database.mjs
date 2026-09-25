// Reset the database to a clean slate.
//
// Default is a DRY RUN: prints what would be removed, deletes nothing.
//
// Usage:
//   node scripts/reset-database.mjs                      # count only
//   node scripts/reset-database.mjs --export=backup.json  # dump first
//   node scripts/reset-database.mjs --apply \
//     --confirm-project=<project-ref> \
//     --confirm-reset=RESET-<project-ref>                 # actually delete
//
// Deleting auth users cascades to nothing on its own, so app tables are
// cleared explicitly in foreign-key order.

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

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const exportArg = argv.find((a) => a.startsWith("--export="));
const projectRefConfirmation = argv.find((a) => a.startsWith("--confirm-project="))?.split("=")[1];
const resetConfirmation = argv.find((a) => a.startsWith("--confirm-reset="))?.split("=")[1];

const projectRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];

if (apply && projectRefConfirmation !== projectRef) {
  console.error(`Refusing to delete: pass --confirm-project=${projectRef} to confirm the target.`);
  process.exit(2);
}

if (apply && resetConfirmation !== `RESET-${projectRef}`) {
  console.error(`Refusing to delete: pass --confirm-reset=RESET-${projectRef} to confirm full data deletion.`);
  process.exit(2);
}

// Order matters: children before parents.
const TABLES = [
  "ride_batch_items",
  "ride_batches",
  "dispatch_event_locks",
  "ride_requests",
  "emergency_events",
  "rider_consents",
  "rider_penalties",
  "rider_rate_limits",
  "api_rate_limits",
  "drivers",
  "events",
  "profiles",
];
const TABLE_COUNT_COLUMN = {
  dispatch_event_locks: "event_id",
  api_rate_limits: "route_key",
};

async function listUsers() {
  const users = [];
  let page = 1;
  while (true) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    users.push(...(data?.users ?? []));
    if (!data?.users || data.users.length < 200) break;
    page++;
    if (page > 50) break;
  }
  return users;
}

const users = await listUsers();

console.log(`\n=== CURRENT DATABASE CONTENTS ===\n`);
console.log(`  auth.users           ${users.length}`);

const counts = {};
for (const t of TABLES) {
  const countColumn = TABLE_COUNT_COLUMN[t] || "id";
  const { count } = await admin.from(t).select(countColumn, { count: "exact", head: true });
  counts[t] = count ?? 0;
  console.log(`  ${t.padEnd(20)} ${counts[t]}`);
}

if (exportArg) {
  const file = exportArg.split("=")[1];
  const dump = {};
  for (const t of TABLES) {
    const { data } = await admin.from(t).select("*");
    dump[t] = data ?? [];
  }
  dump.auth_users = users.map((u) => ({ id: u.id, email: u.email, created_at: u.created_at }));
  fs.writeFileSync(path.join(process.cwd(), file), JSON.stringify(dump, null, 2));
  console.log(`\nBacked up to ${file} (${Object.keys(dump).length} collections)\n`);
}

if (!apply) {
  console.log(`\nDRY RUN - nothing deleted.`);
  console.log(`Re-run with --apply to wipe, or --export=backup.json first.\n`);
  process.exit(0);
}

console.log(`\n=== DELETING ===\n`);

for (const t of TABLES) {
  // Clear the table. Supabase has no TRUNCATE via PostgREST, so delete-all.
  const keyColumn = TABLE_COUNT_COLUMN[t] || "id";
  const { error } = await admin.from(t).delete().not(keyColumn, "is", null);
  console.log(`  ${t.padEnd(20)} ${error ? "FAILED: " + error.message : "cleared"}`);
}

let removed = 0;
for (const u of users) {
  const { error } = await admin.auth.admin.deleteUser(u.id);
  if (error) console.error(`  failed ${u.email}: ${error.message}`);
  else removed++;
}
console.log(`  auth.users           removed ${removed}/${users.length}`);

console.log(`\nDone. You'll need to create a new admin account at /admin/login`);
console.log(`(that requires your ADMIN_SIGNUP_CODE).\n`);
