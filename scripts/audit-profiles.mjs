// List every profile with its role, email and org code, so you can spot
// accounts you did not create.
//
// Usage: node scripts/audit-profiles.mjs [admin|driver]

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const filter = process.argv[2];

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

const { data: profiles } = await admin
  .from("profiles")
  .select("id, role, full_name, fraternity_name, organization_code, created_at")
  .order("created_at", { ascending: true });

const rows = (profiles ?? []).filter((p) => !filter || p.role === filter);

console.log(`\n${rows.length} profile(s)${filter ? ` with role=${filter}` : ""}\n`);
console.log("email".padEnd(34), "name".padEnd(22), "org".padEnd(20), "created");
console.log("-".repeat(100));

for (const p of rows) {
  const email = emailById.get(p.id) ?? "(deleted user)";
  const created = (p.created_at ?? createdById.get(p.id) ?? "").slice(0, 10);
  console.log(
    email.padEnd(34),
    (p.full_name ?? "-").slice(0, 20).padEnd(22),
    (p.organization_code ?? "-").padEnd(20),
    created
  );
}
console.log();
