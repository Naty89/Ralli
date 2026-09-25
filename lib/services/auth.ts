import { supabase } from "@/lib/supabaseClient";
import { Profile } from "@/types/database";

// Sign up for admins (generates organization code).
// Runs through a server route so the signup code check cannot be bypassed
// from the browser, and so the profile is created with the service role.
export async function signUpAdmin(
  email: string,
  password: string,
  fullName: string,
  fraternityName: string,
  signupCode?: string
): Promise<{ data: any; organizationCode: string | null; error: Error | null }> {
  try {
    const res = await fetch("/api/admin/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        fullName,
        fraternityName,
        signupCode: signupCode ?? "",
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        data: null,
        organizationCode: null,
        error: new Error(json.error ?? "Failed to create admin account"),
      };
    }

    // The service-role route creates the user but does not establish a browser
    // session. Sign in here before the UI navigates to the admin dashboard.
    const { data: sessionData, error: sessionError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (sessionError || !sessionData.session) {
      return {
        data: json,
        organizationCode: json.organizationCode ?? null,
        error: new Error("Admin account created. Please sign in with your new credentials."),
      };
    }

    return { data: json, organizationCode: json.organizationCode ?? null, error: null };
  } catch (err) {
    return { data: null, organizationCode: null, error: err as Error };
  }
}

// Sign up for drivers (requires organization code)
export async function signUpDriver(
  email: string,
  password: string,
  fullName: string,
  organizationCode: string
): Promise<{ data: any; error: Error | null }> {
  try {
    const response = await fetch("/api/driver/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, fullName, organizationCode }),
    });
    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { data: null, error: new Error(json.error ?? "Failed to create driver account") };
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      return {
        data: json,
        error: new Error("Driver application submitted. Please sign in to check its approval status."),
      };
    }

    return { data: { ...json, user: data.user }, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
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
