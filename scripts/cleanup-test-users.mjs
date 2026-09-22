// Audit Supabase auth users and remove the accounts created by /api/seed.
//
// Default is a DRY RUN: nothing is deleted. Pass --apply to actually delete.
//
// Usage:
//   node scripts/cleanup-test-users.mjs          # audit only
//   node scripts/cleanup-test-users.mjs --apply  # delete seeded test accounts
//
// Requires the (current) service role key in .env.local.

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env.local not found");
  }
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) {
      env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
}

const apply = process.argv.includes("--apply");

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Accounts created by app/api/seed/route.ts
const SEEDED_EMAILS = new Set([
  "admin@test.com",
  "driver1@test.com",
  "driver2@test.com",
  "driver3@test.com",
]);

function isSeeded(email) {
  if (!email) return false;
  if (SEEDED_EMAILS.has(email.toLowerCase())) return true;
  return /^(admin|driver\d*)@test\.com$/i.test(email);
}

async function listAllUsers() {
  const users = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    users.push(...(data?.users ?? []));
    if (!data?.users || data.users.length < perPage) break;
    page++;
    if (page > 50) break; // safety valve
  }
  return users;
}

const users = await listAllUsers();

console.log(`\nFound ${users.length} auth user(s)\n`);
console.log("email".padEnd(32), "created".padEnd(22), "last sign in");
console.log("-".repeat(80));

for (const u of users) {
  const created = u.created_at ? new Date(u.created_at).toISOString().slice(0, 19) : "-";
  const last = u.last_sign_in_at ? new Date(u.last_sign_in_at).toISOString().slice(0, 19) : "never";
  const flag = isSeeded(u.email) ? "  <-- SEEDED TEST ACCOUNT" : "";
  console.log((u.email ?? "(no email)").padEnd(32), created.padEnd(22), last + flag);
}

const toDelete = users.filter((u) => isSeeded(u.email));

console.log(`\n${toDelete.length} seeded test account(s) matched.`);

if (toDelete.length === 0) {
  console.log("Nothing to delete.\n");
  process.exit(0);
}

if (!apply) {
  console.log("\nDRY RUN - nothing was deleted.");
  console.log("Re-run with --apply to delete the accounts listed above.\n");
  process.exit(0);
}

console.log("\nDeleting...");
for (const u of toDelete) {
  const { error } = await admin.auth.admin.deleteUser(u.id);
  if (error) {
    console.error(`  FAILED ${u.email}: ${error.message}`);
  } else {
    console.log(`  deleted ${u.email}`);
  }
}

// Remove profiles with no matching auth user.
const { data: remaining } = await admin.auth.admin.listUsers({ perPage: 200 });
if (remaining?.users) {
  const validIds = new Set(remaining.users.map((u) => u.id));
  const { data: profiles } = await admin.from("profiles").select("id");
  const orphans = (profiles ?? []).filter((p) => !validIds.has(p.id));
  for (const p of orphans) {
    await admin.from("profiles").delete().eq("id", p.id);
    console.log(`  deleted orphan profile ${p.id}`);
  }
}

console.log("\nNOTE: anything NOT flagged above was left alone. Review the list");
console.log("and delete suspicious accounts from Authentication -> Users by hand.\n");
