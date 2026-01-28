"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Car,
  LogOut,
  MapPin,
  Users,
  Navigation,
  CheckCircle,
  Power,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Badge, DriverStatusBadge, RideStatusBadge } from "@/components/ui";
import { EmergencyButton } from "@/components/EmergencyButton";
import { BatchPickupList } from "@/components/BatchPickupList";
import { getCurrentUser, signOut } from "@/lib/services/auth";
import {
  getDriverByProfileId,
  getDriverCurrentRide,
  updateDriverStatus,
  updateDriverLocation,
  subscribeToDriver,
} from "@/lib/services/drivers";
import { subscribeToRideRequest } from "@/lib/services/rides";
import { getEventById } from "@/lib/services/events";
import { transitionRideStatus } from "@/lib/services/dispatchService";
import { updateRideETA, formatETA } from "@/lib/services/etaService";
import { triggerEmergency } from "@/lib/services/emergencyService";
import {
  getDriverActiveBatch,
  markPickupComplete,
  completeBatch,
} from "@/lib/services/batchService";
import { Profile, Driver, RideRequest, Event, RideBatch, RideBatchItem } from "@/types/database";

export default function DriverDashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [driver, setDriver] = useState<Driver | null>(null);
  const [currentRide, setCurrentRide] = useState<RideRequest | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);

  // Phase 3: Batch state
  const [activeBatch, setActiveBatch] = useState<RideBatch | null>(null);
  const [currentPickupIndex, setCurrentPickupIndex] = useState(0);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!driver) return;

    // Subscribe to driver updates
    const driverSub = subscribeToDriver(driver.id, () => {
      loadDriverData(profile?.id);
    });

    return () => {
      driverSub.unsubscribe();
    };
  }, [driver?.id]);

  useEffect(() => {
    if (!currentRide) return;

    // Subscribe to ride updates
    const rideSub = subscribeToRideRequest(currentRide.id, () => {
      loadRideData();
    });

    return () => {
      rideSub.unsubscribe();
    };
  }, [currentRide?.id]);

  // Track location when online
  useEffect(() => {
    if (!driver || driver.current_status === "offline") return;

    let watchId: number;

    if ("geolocation" in navigator) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          updateDriverLocation(
            driver.id,
            position.coords.latitude,
            position.coords.longitude
          );
        },
        (error) => {
          console.error("Geolocation error:", error);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    }

    return () => {
      if (watchId) navigator.geolocation.clearWatch(watchId);
    };
  }, [driver?.id, driver?.current_status]);

  const loadData = async () => {
    const { user, profile: userProfile, error } = await getCurrentUser();
    if (error || !userProfile) {
      router.push("/driver/login");
      return;
    }
    setProfile(userProfile);

    await loadDriverData(userProfile.id);
    setIsLoading(false);
  };

  const loadDriverData = async (profileId?: string) => {
    const id = profileId || profile?.id;
    if (!id) return;

    const { data: driverData } = await getDriverByProfileId(id);
    if (driverData) {
      setDriver(driverData);

      // Load event
      const { data: eventData } = await getEventById(driverData.event_id);
      setEvent(eventData);

      // Load current ride
      await loadRideData(driverData.id);
    }
  };

  const loadRideData = async (driverId?: string) => {
    const id = driverId || driver?.id;
    if (!id) return;

    const { data: rideData } = await getDriverCurrentRide(id);
    setCurrentRide(rideData);

    // Load batch data if driver is assigned
    const { data: batchData } = await getDriverActiveBatch(id);
    setActiveBatch(batchData);

    // Calculate current pickup index
    if (batchData?.items) {
      const sortedItems = [...batchData.items].sort(
        (a, b) => a.pickup_order_index - b.pickup_order_index
      );
      const firstPending = sortedItems.findIndex((item) => !item.picked_up);
      setCurrentPickupIndex(firstPending >= 0 ? firstPending : sortedItems.length);
    }
  };

  const handleSignOut = async () => {
    if (driver && driver.current_status !== "offline") {
      await updateDriverStatus(driver.id, "offline");
    }
    await signOut();
    router.push("/");
  };

  const handleToggleOnline = async () => {
    if (!driver) return;
    setIsUpdating(true);

    const newStatus = driver.current_status === "offline" ? "available" : "offline";
    await updateDriverStatus(driver.id, newStatus);
    await loadDriverData(profile?.id);
    setIsUpdating(false);
  };

  const handleMarkArrived = async () => {
    if (!currentRide) return;
    setIsUpdating(true);
    await transitionRideStatus(currentRide.id, "arrived");
    await loadRideData();
    setIsUpdating(false);
  };

  const handleStartRide = async () => {
    if (!currentRide) return;
    setIsUpdating(true);
    await transitionRideStatus(currentRide.id, "in_progress");
    await loadRideData();
    setIsUpdating(false);
  };

  const handleCompleteRide = async () => {
    if (!currentRide || !driver) return;
    setIsUpdating(true);
    await transitionRideStatus(currentRide.id, "completed", driver.id);
    setCurrentRide(null);
    await loadDriverData(profile?.id);
    setIsUpdating(false);
  };

  const openNavigation = (lat?: number, lng?: number, address?: string) => {
    const targetLat = lat || currentRide?.pickup_lat;
    const targetLng = lng || currentRide?.pickup_lng;
    if (!targetLat || !targetLng) return;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${targetLat},${targetLng}`;
    window.open(url, "_blank");
  };

  // Handle pickup complete for batch rides
  const handlePickupComplete = async (itemId: string) => {
    setIsUpdating(true);
    await markPickupComplete(itemId);
    await loadRideData();
    setIsUpdating(false);
  };

  // Handle complete entire batch
  const handleCompleteBatch = async () => {
    if (!activeBatch) return;
    setIsUpdating(true);
    await completeBatch(activeBatch.id);
    setActiveBatch(null);
    setCurrentRide(null);
    await loadDriverData(profile?.id);
    setIsUpdating(false);
  };

  // Handle emergency trigger
  const handleEmergency = async () => {
    if (!event || !driver) return;

    await triggerEmergency(
      event.id,
      currentRide?.id || null,
      "driver",
      profile?.full_name || "Unknown Driver",
      userLocation?.lat || driver.current_lat,
      userLocation?.lng || driver.current_lng
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div>
      </div>
    );
  }

  if (!driver) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="max-w-md w-full text-center py-8">
          <Car className="h-12 w-12 text-dark-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">Not Assigned to Event</h2>
          <p className="text-dark-400 mb-6">
            You haven't been assigned to any active event yet. Please contact your admin.
          </p>
          <Button variant="secondary" onClick={handleSignOut}>
            Sign Out
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-950">
      {/* Header */}
      <header className="border-b border-dark-800 bg-dark-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Car className="h-6 w-6 text-green-500" />
              <div>
                <span className="font-bold">Ralli</span>
                <span className="text-dark-500 ml-2">Driver</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <DriverStatusBadge status={driver.current_status} />
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Event Info */}
        {event && (
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-dark-400">Current Event</p>
                <p className="font-medium">{event.event_name}</p>
              </div>
              <Badge variant={event.is_active ? "available" : "offline"}>
                {event.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
          </Card>
        )}

        {/* Online Toggle */}
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold">
                {driver.current_status === "offline" ? "You're Offline" : "You're Online"}
              </h2>
              <p className="text-sm text-dark-400">
                {driver.current_status === "offline"
                  ? "Go online to receive ride assignments"
                  : driver.current_status === "available"
                  ? "Waiting for ride assignment..."
                  : "You have an active ride"}
              </p>
            </div>
            <button
              onClick={handleToggleOnline}
              disabled={isUpdating || driver.current_status === "assigned"}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
                driver.current_status === "offline"
                  ? "bg-dark-800 hover:bg-dark-700 text-dark-400"
                  : "bg-green-600 hover:bg-green-700 text-white"
              } ${isUpdating ? "opacity-50" : ""}`}
            >
              <Power className="h-8 w-8" />
            </button>
          </div>
        </Card>

        {/* Batch Pickup List - show when driver has a batch */}
        {activeBatch && activeBatch.items && activeBatch.items.length > 1 && (
          <Card className="overflow-hidden">
            <div className="bg-primary-900/30 px-6 py-3 border-b border-dark-800">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Batch Pickups</h2>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-dark-400" />
                  <span className="text-sm text-dark-300">
                    {driver?.current_passenger_load || 0}/{driver?.max_capacity || 4}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-4">
              <BatchPickupList
                items={activeBatch.items}
                currentIndex={currentPickupIndex}
                onPickupComplete={handlePickupComplete}
                onNavigate={openNavigation}
                isLoading={isUpdating}
              />

              {/* Complete batch button - show when all pickups done */}
              {activeBatch.items.every((item) => item.picked_up) && (
                <div className="mt-4 pt-4 border-t border-dark-800">
                  <Button
                    variant="success"
                    className="w-full"
                    onClick={handleCompleteBatch}
                    isLoading={isUpdating}
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Complete All Drop-offs
                  </Button>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Current Ride - show for single rides or when not in batch mode */}
        {currentRide && (!activeBatch || activeBatch.items?.length === 1) && (
          <Card className="overflow-hidden">
            <div className="bg-primary-900/30 px-6 py-3 border-b border-dark-800">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Current Ride</h2>
                <RideStatusBadge status={currentRide.status} />
              </div>
            </div>

            <div className="p-6 space-y-4">
              {/* Rider Info */}
              <div>
                <p className="text-sm text-dark-400">Rider</p>
                <p className="font-medium text-lg">{currentRide.rider_name}</p>
              </div>

              {/* Pickup Address */}
              <div>
                <p className="text-sm text-dark-400">Pickup Location</p>
                <div className="flex items-start gap-2 mt-1">
                  <MapPin className="h-5 w-5 text-primary-400 shrink-0" />
                  <p className="font-medium">{currentRide.pickup_address}</p>
                </div>
              </div>

              {/* Passenger Count */}
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-dark-400" />
                <span>
                  {currentRide.passenger_count} passenger
                  {currentRide.passenger_count > 1 ? "s" : ""}
                </span>
              </div>

              {/* Capacity indicator */}
              {driver && (
                <div className="flex items-center gap-2 text-sm text-dark-400">
                  <span>Vehicle capacity:</span>
                  <span className="font-medium text-dark-300">
                    {driver.current_passenger_load || 0}/{driver.max_capacity || 4}
                  </span>
                </div>
              )}

              {/* ETA Display */}
              {currentRide.status === "assigned" && currentRide.driver_eta_minutes && (
                <div className="bg-cyan-900/20 rounded-lg p-3 flex items-center justify-center gap-2">
                  <Clock className="h-5 w-5 text-cyan-400" />
                  <span className="text-cyan-400 font-medium">
                    ETA: {formatETA(currentRide.driver_eta_minutes)}
                  </span>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-4">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => openNavigation()}
                >
                  <Navigation className="h-4 w-4 mr-2" />
                  Navigate
                </Button>

                {currentRide.status === "assigned" && (
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={handleMarkArrived}
                    isLoading={isUpdating}
                  >
                    <Clock className="h-4 w-4 mr-2" />
                    Arrived
                  </Button>
                )}

                {currentRide.status === "arrived" && (
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={handleStartRide}
                    isLoading={isUpdating}
                  >
                    <Car className="h-4 w-4 mr-2" />
                    Start Ride
                  </Button>
                )}

                {currentRide.status === "in_progress" && (
                  <Button
                    variant="success"
                    className="flex-1"
                    onClick={handleCompleteRide}
                    isLoading={isUpdating}
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Complete
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Waiting State */}
        {driver.current_status === "available" && !currentRide && (
          <Card className="text-center py-12">
            <div className="animate-pulse mb-4">
              <Clock className="h-12 w-12 text-dark-600 mx-auto" />
            </div>
            <h3 className="font-medium text-dark-300">Waiting for Assignment</h3>
            <p className="text-dark-500 text-sm mt-1">
              You'll be notified when you're assigned a ride
            </p>
          </Card>
        )}

        {/* Offline State */}
        {driver.current_status === "offline" && (
          <Card className="text-center py-12">
            <Power className="h-12 w-12 text-dark-600 mx-auto mb-4" />
            <h3 className="font-medium text-dark-300">You're Offline</h3>
            <p className="text-dark-500 text-sm mt-1">
              Tap the power button above to go online
            </p>
          </Card>
        )}

        {/* Driver Info */}
        <div className="text-center text-sm text-dark-500">
          <p>Signed in as {profile?.full_name}</p>
          <p>{profile?.fraternity_name}</p>
        </div>
      </div>

      {/* Emergency Button - show during active ride states */}
      {currentRide &&
        ["assigned", "arrived", "in_progress"].includes(currentRide.status) && (
          <EmergencyButton onTrigger={handleEmergency} />
        )}
    </div>
  );
}
