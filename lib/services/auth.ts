import { supabase } from "@/lib/supabaseClient";
import { Profile, UserRole } from "@/types/database";

// Sign up with email and password
export async function signUp(
  email: string,
  password: string,
  fullName: string,
  fraternityName: string,
  role: UserRole
): Promise<{ data: any; error: Error | null }> {
  // Create auth user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Store user metadata that can be used if email confirmation is enabled
      data: {
        full_name: fullName,
        fraternity_name: fraternityName,
        role,
      },
    },
  });

  if (authError) {
    return { data: null, error: new Error(authError.message) };
  }

  if (!authData.user) {
    return { data: null, error: new Error("Failed to create user") };
  }

  // Check if email confirmation is required (user won't have a session)
  if (!authData.session) {
    // Email confirmation is enabled - user needs to confirm email first
    // Profile will be created via database trigger or after confirmation
    return {
      data: authData,
      error: new Error("Please check your email to confirm your account before signing in.")
    };
  }

  // Create profile (only if we have a session, meaning email confirmation is disabled)
  const { error: profileError } = await supabase.from("profiles").insert({
    id: authData.user.id,
    full_name: fullName,
    fraternity_name: fraternityName,
    role,
  } as any);

  if (profileError) {
    return { data: null, error: new Error(profileError.message) };
  }

  return { data: authData, error: null };
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
