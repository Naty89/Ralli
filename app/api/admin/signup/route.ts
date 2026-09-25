import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { checkPublicApiRateLimit } from "@/lib/services/apiRateLimit";
import { randomInt, timingSafeEqual } from "crypto";

// Admin signup must not be self-serve: anyone who can reach /admin/login could
// otherwise create an admin account, read their own organization code off the
// dashboard, and take over an event (renaming drivers, moving their pins, etc).
// Set ADMIN_SIGNUP_CODE in the environment and share it only with real
// organizers. When it is unset, signup is refused.

function generateOrganizationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(randomInt(chars.length));
  }
  return result;
}

function matchesSignupCode(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

export async function POST(request: Request) {
  const rate = await checkPublicApiRateLimit(request, "admin-signup", 5, 3600);
  if (rate.error) return NextResponse.json({ error: "Signup temporarily unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json({ error: "Too many signup attempts. Try again later." }, { status: 429 });

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

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    typeof fullName !== "string" ||
    typeof fraternityName !== "string" ||
    !email.trim() ||
    !fullName.trim() ||
    !fraternityName.trim()
  ) {
    return NextResponse.json(
      { error: "email, password, fullName and fraternityName are required" },
      { status: 400 }
    );
  }

  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 }
    );
  }

  if (!matchesSignupCode(signupCode, expectedCode)) {
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

  let organizationCode = "";
  let profileError: { message: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    organizationCode = generateOrganizationCode();
    const result = await admin.from("profiles").insert({
      id: authData.user.id,
      full_name: fullName.trim(),
      fraternity_name: fraternityName.trim(),
      role: "admin",
      approval_status: "approved",
      organization_code: organizationCode,
    });
    profileError = result.error;
    if (!profileError) break;
    if (profileError.message.toLowerCase().includes("uniq_admin_organization_code")) continue;
    break;
  }

  if (profileError) {
    // Don't leave an orphan auth user behind.
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ organizationCode });
}
