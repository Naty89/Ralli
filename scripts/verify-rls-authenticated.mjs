// Verify that an AUTHENTICATED admin can still read the tables after the RLS
// changes. Creates a temporary admin user, signs in with it (real session),
// runs the same reads the admin dashboard makes, then removes it again.
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
const anon = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

const email = `rls-verify-${Date.now()}@ralli.invalid`;
const password = `V3rify-${Math.random().toString(36).slice(2)}-x`;

// Use a real fraternity so the org-scoped profile policy has something to match.
const { data: sample } = await admin.from("profiles").select("fraternity_name").limit(1).maybeSingle();
const fraternity = sample?.fraternity_name ?? "RLS Verify Org";

const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (createErr || !created?.user) {
  console.error("could not create temp user:", createErr?.message);
  process.exit(1);
}
const userId = created.user.id;

try {
  await admin.from("profiles").insert({
    id: userId,
    role: "admin",
    full_name: "RLS Verify Temp",
    fraternity_name: fraternity,
    organization_code: "VERIFY",
  });

  const { error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) {
    console.error("sign in failed:", signInErr.message);
    process.exit(1);
  }
  console.log(`\nSigned in as temp admin (org="${fraternity}")\n`);

  const checks = [
    ["profiles", "select id, full_name, role from profiles limit 5"],
    ["drivers", "select id, event_id, profile_id from drivers limit 5"],
    ["events", "select id, event_name from events limit 5"],
    ["ride_requests", "select id, status from ride_requests limit 5"],
    ["ride_batches", "select id, status from ride_batches limit 5"],
    ["emergency_events", "select id from emergency_events limit 5"],
  ];

  for (const [name, _q] of checks) {
    const { data, error } = await anon.from(name).select("*").limit(5);
    if (error) {
      console.log(`  ${name.padEnd(18)} ERROR ${error.code} :: ${error.message}`);
    } else {
      console.log(`  ${name.padEnd(18)} OK - ${(data ?? []).length} row(s) visible`);
    }
  }

  // The join the admin dashboard actually performs.
  const { data: joined, error: joinErr } = await anon
    .from("drivers")
    .select("id, profile:profiles(full_name)")
    .limit(5);
  console.log(
    `\n  drivers->profiles join: ${joinErr ? `ERROR ${joinErr.code} :: ${joinErr.message}` : `OK - ${(joined ?? []).length} row(s)`}`
  );
} finally {
  await admin.from("profiles").delete().eq("id", userId);
  await admin.auth.admin.deleteUser(userId);
  console.log("\nTemp admin removed.\n");
}
