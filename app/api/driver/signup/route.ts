import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { checkPublicApiRateLimit } from "@/lib/services/apiRateLimit";

// Driver signup is server-provisioned. The organization code is checked using
// the service role, and the server fixes role=driver plus approval_status=pending
// so a caller cannot submit a forged admin profile through PostgREST.

export async function POST(request: Request) {
  const rate = await checkPublicApiRateLimit(request, "driver-signup", 20, 3600);
  if (rate.error) return NextResponse.json({ error: "Signup temporarily unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json({ error: "Too many signup attempts. Try again later." }, { status: 429 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";
  const organizationCode = typeof body?.organizationCode === "string"
    ? body.organizationCode.trim().toUpperCase()
    : "";

  if (!email || !password || !fullName || !organizationCode) {
    return NextResponse.json(
      { error: "Email, password, name and organization code are required" },
      { status: 400 }
    );
  }

  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 }
    );
  }

  if (fullName.length > 120 || organizationCode.length !== 6) {
    return NextResponse.json({ error: "Invalid name or organization code" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: organization, error: organizationError } = await admin
    .from("profiles")
    .select("id, fraternity_name, organization_code")
    .eq("role", "admin")
    .eq("approval_status", "approved")
    .eq("organization_code", organizationCode)
    .maybeSingle();

  if (organizationError) {
    return NextResponse.json({ error: "Unable to validate organization code" }, { status: 500 });
  }
  if (!organization) {
    return NextResponse.json(
      { error: "Invalid organization code. Please check with your admin." },
      { status: 400 }
    );
  }

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    // This is the app's existing immediate-signup model. Organization-wide
    // approval prevents the account from receiving event driver access.
    email_confirm: true,
    user_metadata: { full_name: fullName, fraternity_name: organization.fraternity_name },
  });

  if (authError || !authData.user) {
    return NextResponse.json(
      { error: authError?.message ?? "Failed to create driver account" },
      { status: 400 }
    );
  }

  const { error: profileError } = await admin.from("profiles").insert({
    id: authData.user.id,
    full_name: fullName,
    fraternity_name: organization.fraternity_name,
    organization_code: organization.organization_code,
    role: "driver",
    approval_status: "pending",
  });

  if (profileError) {
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, approval_status: "pending" }, { status: 201 });
}
