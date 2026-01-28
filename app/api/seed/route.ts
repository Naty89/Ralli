import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

// Use service role for seeding (bypasses RLS)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST() {
  try {
    // Helper to create or get existing user
    async function getOrCreateUser(email: string, password: string) {
      // Try to create user
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (data?.user) {
        return data.user.id;
      }

      // If user exists, find them and update password
      const { data: users } = await supabaseAdmin.auth.admin.listUsers();
      const existingUser = users?.users?.find(u => u.email === email);

      if (existingUser) {
        // Update password to match test credentials
        await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
          password,
        });
        return existingUser.id;
      }

      return null;
    }

    // Create test admin user
    const adminId = await getOrCreateUser("admin@test.com", "password123");

    // Create test driver users
    const driver1Id = await getOrCreateUser("driver1@test.com", "password123");
    const driver2Id = await getOrCreateUser("driver2@test.com", "password123");
    const driver3Id = await getOrCreateUser("driver3@test.com", "password123");

    // Create profiles
    if (adminId) {
      await supabaseAdmin.from("profiles").upsert({
        id: adminId,
        role: "admin",
        full_name: "Test Admin",
        fraternity_name: "Alpha Beta Gamma",
      });
    }

    if (driver1Id) {
      await supabaseAdmin.from("profiles").upsert({
        id: driver1Id,
        role: "driver",
        full_name: "Mike Johnson",
        fraternity_name: "Alpha Beta Gamma",
      });
    }

    if (driver2Id) {
      await supabaseAdmin.from("profiles").upsert({
        id: driver2Id,
        role: "driver",
        full_name: "Chris Smith",
        fraternity_name: "Alpha Beta Gamma",
      });
    }

    if (driver3Id) {
      await supabaseAdmin.from("profiles").upsert({
        id: driver3Id,
        role: "driver",
        full_name: "Alex Brown",
        fraternity_name: "Alpha Beta Gamma",
      });
    }

    // Create test event
    const { data: eventData, error: eventError } = await supabaseAdmin
      .from("events")
      .insert({
        fraternity_name: "Alpha Beta Gamma",
        event_name: "Spring Formal 2024",
        access_code: "TEST01",
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), // 8 hours from now
        is_active: true,
        created_by: adminId,
      })
      .select()
      .single();

    if (eventError && !eventError.message.includes("duplicate")) {
      throw eventError;
    }

    const eventId = eventData?.id;

    // Assign drivers to event
    if (eventId && driver1Id) {
      await supabaseAdmin.from("drivers").upsert({
        event_id: eventId,
        profile_id: driver1Id,
        is_online: true,
        current_status: "available",
      }, { onConflict: "event_id,profile_id" });
    }

    if (eventId && driver2Id) {
      await supabaseAdmin.from("drivers").upsert({
        event_id: eventId,
        profile_id: driver2Id,
        is_online: true,
        current_status: "available",
      }, { onConflict: "event_id,profile_id" });
    }

    if (eventId && driver3Id) {
      await supabaseAdmin.from("drivers").upsert({
        event_id: eventId,
        profile_id: driver3Id,
        is_online: false,
        current_status: "offline",
      }, { onConflict: "event_id,profile_id" });
    }

    // Create test ride requests
    if (eventId) {
      const testRiders = [
        { name: "Emma Wilson", address: "123 Main St, College Town", lat: 40.7128, lng: -74.006, passengers: 2 },
        { name: "James Brown", address: "456 Oak Ave, College Town", lat: 40.7138, lng: -74.007, passengers: 3 },
        { name: "Sarah Davis", address: "789 Elm St, College Town", lat: 40.7148, lng: -74.008, passengers: 1 },
        { name: "Michael Lee", address: "321 Pine Rd, College Town", lat: 40.7158, lng: -74.009, passengers: 4 },
        { name: "Jessica Martinez", address: "654 Maple Dr, College Town", lat: 40.7168, lng: -74.010, passengers: 2 },
      ];

      for (const rider of testRiders) {
        await supabaseAdmin.from("ride_requests").insert({
          event_id: eventId,
          rider_name: rider.name,
          pickup_address: rider.address,
          pickup_lat: rider.lat,
          pickup_lng: rider.lng,
          passenger_count: rider.passengers,
          status: "waiting",
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Test data seeded successfully",
      data: {
        admin: { email: "admin@test.com", password: "password123" },
        drivers: [
          { email: "driver1@test.com", password: "password123" },
          { email: "driver2@test.com", password: "password123" },
          { email: "driver3@test.com", password: "password123" },
        ],
        event: { accessCode: "TEST01" },
      },
    });
  } catch (error: any) {
    console.error("Seed error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// GET endpoint to check seed status
export async function GET() {
  return NextResponse.json({
    message: "POST to this endpoint to seed test data",
    credentials: {
      admin: { email: "admin@test.com", password: "password123" },
      drivers: [
        { email: "driver1@test.com", password: "password123" },
        { email: "driver2@test.com", password: "password123" },
        { email: "driver3@test.com", password: "password123" },
      ],
      event: { accessCode: "TEST01" },
    },
  });
}
