import { supabase } from "@/lib/supabaseClient";
import { Profile, UserRole } from "@/types/database";

// Generate a random 6-character organization code
function generateOrganizationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Validate that an organization code exists (for driver signup)
export async function validateOrganizationCode(
  code: string
): Promise<{ valid: boolean; fraternityName: string | null }> {
  const { data, error } = await supabase
    .from("profiles")
    .select("fraternity_name")
    .eq("organization_code", code.toUpperCase())
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return { valid: false, fraternityName: null };
  }

  return { valid: true, fraternityName: data.fraternity_name };
}

// Sign up for admins (generates organization code)
export async function signUpAdmin(
  email: string,
  password: string,
  fullName: string,
  fraternityName: string
): Promise<{ data: any; organizationCode: string | null; error: Error | null }> {
  // Create auth user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        fraternity_name: fraternityName,
        role: "admin",
      },
    },
  });

  if (authError) {
    return { data: null, organizationCode: null, error: new Error(authError.message) };
  }

  if (!authData.user) {
    return { data: null, organizationCode: null, error: new Error("Failed to create user") };
  }

  // Check if email confirmation is required
  if (!authData.session) {
    return {
      data: authData,
      organizationCode: null,
      error: new Error("Please check your email to confirm your account before signing in.")
    };
  }

  // Generate unique organization code
  const organizationCode = generateOrganizationCode();

  // Create profile with organization code
  const { error: profileError } = await supabase.from("profiles").insert({
    id: authData.user.id,
    full_name: fullName,
    fraternity_name: fraternityName,
    role: "admin",
    organization_code: organizationCode,
  } as any);

  if (profileError) {
    return { data: null, organizationCode: null, error: new Error(profileError.message) };
  }

  return { data: authData, organizationCode, error: null };
}

// Sign up for drivers (requires organization code)
export async function signUpDriver(
  email: string,
  password: string,
  fullName: string,
  organizationCode: string
): Promise<{ data: any; error: Error | null }> {
  // First validate the organization code
  const { valid, fraternityName } = await validateOrganizationCode(organizationCode);

  if (!valid || !fraternityName) {
    return { data: null, error: new Error("Invalid organization code. Please check with your admin.") };
  }

  // Create auth user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        fraternity_name: fraternityName,
        role: "driver",
      },
    },
  });

  if (authError) {
    return { data: null, error: new Error(authError.message) };
  }

  if (!authData.user) {
    return { data: null, error: new Error("Failed to create user") };
  }

  // Check if email confirmation is required
  if (!authData.session) {
    return {
      data: authData,
      error: new Error("Please check your email to confirm your account before signing in.")
    };
  }

  // Create profile with same organization code
  const { error: profileError } = await supabase.from("profiles").insert({
    id: authData.user.id,
    full_name: fullName,
    fraternity_name: fraternityName,
    role: "driver",
    organization_code: organizationCode.toUpperCase(),
  } as any);

  if (profileError) {
    return { data: null, error: new Error(profileError.message) };
  }

  return { data: authData, error: null };
}

// Legacy signUp function (kept for compatibility)
export async function signUp(
  email: string,
  password: string,
  fullName: string,
  fraternityName: string,
  role: UserRole
): Promise<{ data: any; error: Error | null }> {
  if (role === "admin") {
    const result = await signUpAdmin(email, password, fullName, fraternityName);
    return { data: result.data, error: result.error };
  } else {
    // For drivers using old signup, fraternityName is actually the org code
    return signUpDriver(email, password, fullName, fraternityName);
  }
}

// Sign in with email and password
export async function signIn(
  email: string,
  password: string
): Promise<{ data: any; error: Error | null }> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Sign out
export async function signOut(): Promise<{ error: Error | null }> {
  const { error } = await supabase.auth.signOut();

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}

// Get current user
export async function getCurrentUser(): Promise<{
  user: any;
  profile: Profile | null;
  error: Error | null;
}> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { user: null, profile: null, error: userError ? new Error(userError.message) : null };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (profileError) {
    return { user, profile: null, error: new Error(profileError.message) };
  }

  return { user, profile, error: null };
}

// Get user profile
export async function getUserProfile(
  userId: string
): Promise<{ data: Profile | null; error: Error | null }> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Update profile
export async function updateProfile(
  userId: string,
  updates: Partial<Profile>
): Promise<{ error: Error | null }> {
  const { error } = await (supabase
    .from("profiles") as any)
    .update(updates)
    .eq("id", userId);

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}
