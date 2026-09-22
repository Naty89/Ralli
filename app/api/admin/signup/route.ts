import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";

// Admin signup must not be self-serve: anyone who can reach /admin/login could
// otherwise create an admin account, read their own organization code off the
// dashboard, and take over an event (renaming drivers, moving their pins, etc).
// Set ADMIN_SIGNUP_CODE in the environment and share it only with real
// organizers. When it is unset, signup is refused.

function generateOrganizationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function POST(request: Request) {
  const expectedCode = process.env.ADMIN_SIGNUP_CODE;

  if (!expectedCode) {
    return NextResponse.json(
      {
        error:
          "Admin signup is disabled. Set ADMIN_SIGNUP_CODE in the environment to enable it.",
      },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { email, password, fullName, fraternityName, signupCode } = body ?? {};

  if (!email || !password || !fullName || !fraternityName) {
    return NextResponse.json(
      { error: "email, password, fullName and fraternityName are required" },
      { status: 400 }
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  if (signupCode !== expectedCode) {
    return NextResponse.json(
      { error: "Invalid admin signup code" },
      { status: 403 }
    );
  }

  const admin = createAdminClient();

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      fraternity_name: fraternityName,
      role: "admin",
    },
  });

  if (authError || !authData?.user) {
    return NextResponse.json(
      { error: authError?.message ?? "Failed to create user" },
      { status: 400 }
    );
  }

  const organizationCode = generateOrganizationCode();

  const { error: profileError } = await admin.from("profiles").insert({
    id: authData.user.id,
    full_name: fullName,
    fraternity_name: fraternityName,
    role: "admin",
    organization_code: organizationCode,
  });

  if (profileError) {
    // Don't leave an orphan auth user behind.
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ organizationCode });
}
