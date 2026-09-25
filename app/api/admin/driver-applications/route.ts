import { NextResponse } from "next/server";
import { createAdminClient, createServerSupabaseClient } from "@/lib/supabaseServer";

async function getAdminContext() {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user }, error: authError } = await sessionClient.auth.getUser();
  if (authError || !user) return { error: "Authentication required", status: 401 as const };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role, approval_status, fraternity_name, organization_code")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role !== "admin" || profile.approval_status !== "approved") {
    return { error: "Approved admin access required", status: 403 as const };
  }

  return { admin, profile };
}

export async function GET() {
  const context = await getAdminContext();
  if ("error" in context) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  const { data, error } = await context.admin
    .from("profiles")
    .select("id, full_name, fraternity_name, organization_code, approval_status, created_at")
    .eq("role", "driver")
    .eq("organization_code", context.profile.organization_code)
    .in("approval_status", ["pending", "rejected"])
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const applications = await Promise.all((data ?? []).map(async (application) => {
    const { data: authUser } = await context.admin.auth.admin.getUserById(application.id);
    return { ...application, email: authUser.user?.email ?? null };
  }));

  return NextResponse.json({ data: applications });
}

export async function PATCH(request: Request) {
  const context = await getAdminContext();
  if ("error" in context) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const profileId = body?.profile_id;
  const decision = body?.decision;
  if (typeof profileId !== "string" || !["approved", "rejected"].includes(decision)) {
    return NextResponse.json({ error: "profile_id and valid decision required" }, { status: 400 });
  }

  const { data: target, error: targetError } = await context.admin
    .from("profiles")
    .select("id, role, fraternity_name, organization_code, approval_status")
    .eq("id", profileId)
    .maybeSingle();

  if (targetError) return NextResponse.json({ error: targetError.message }, { status: 500 });
  if (
    !target ||
    target.role !== "driver" ||
    target.organization_code !== context.profile.organization_code ||
    !["pending", "rejected"].includes(target.approval_status)
  ) {
    return NextResponse.json({ error: "Driver application not found for your organization" }, { status: 404 });
  }

  const { error: updateError } = await context.admin
    .from("profiles")
    .update({
      approval_status: decision,
      approval_decided_at: new Date().toISOString(),
      approval_decided_by: context.profile.id,
    })
    .eq("id", profileId);

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  return NextResponse.json({ success: true, approval_status: decision });
}
