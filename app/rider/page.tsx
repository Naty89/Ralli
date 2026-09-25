"use client";

import { useState, useEffect, Suspense, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Car,
  MapPin,
  Users,
  Clock,
  CheckCircle,
  Navigation,
  ArrowLeft,
  Loader2,
  Timer,
  MapPinned,
  Hand,
} from "lucide-react";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Badge, RideStatusBadge } from "@/components/ui";
import { PlacesAutocomplete } from "@/components/PlacesAutocomplete";
import { DriverLocationMap } from "@/components/DriverLocationMap";
import { TOSModal } from "@/components/TOSModal";
import { NoShowCountdown } from "@/components/NoShowCountdown";
import { EmergencyButton } from "@/components/EmergencyButton";
import { CooldownNotice } from "@/components/CooldownNotice";
import { BatchPosition } from "@/components/BatchPickupList";
import { getEventByAccessCode } from "@/lib/services/events";
import { getRideRequestById, cancelRideRequest, updateRideRequest } from "@/lib/services/rides";
import { formatETA } from "@/lib/services/etaService";
import { recordConsent } from "@/lib/services/consentService";
import { confirmRiderPresence } from "@/lib/services/safetyService";
import { triggerEmergency } from "@/lib/services/emergencyService";
import { Event, RideRequest, Driver, CooldownStatus } from "@/types/database";

// How often the rider screen refreshes. Riders watch a multi-minute ETA
// countdown, not a live map, so 10s is plenty and keeps load down when
// hundreds of riders are waiting at once.
const RIDE_POLL_MS = 10000;

function RiderContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialCode = searchParams.get("code") || "";

  const [step, setStep] = useState<"code" | "form" | "status">("code");
  const [accessCode, setAccessCode] = useState(initialCode);
  const [event, setEvent] = useState<Event | null>(null);
  const [rideRequest, setRideRequest] = useState<RideRequest | null>(null);
  const [rideAccessToken, setRideAccessToken] = useState<string | null>(null);
  const [queuePosition, setQueuePosition] = useState({ position: 0, total: 0 });
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);

  // Form state
  const [riderName, setRiderName] = useState("");
  const [riderPhone, setRiderPhone] = useState("");
  const [pickupAddress, setPickupAddress] = useState("");
  const [pickupLat, setPickupLat] = useState(0);
  const [pickupLng, setPickupLng] = useState(0);
  const [passengerCount, setPassengerCount] = useState(1);
  const [rideDirection, setRideDirection] = useState<"to_event" | "from_event">("to_event");
  const [dropoffAddress, setDropoffAddress] = useState("");
  const [dropoffLat, setDropoffLat] = useState(0);
  const [dropoffLng, setDropoffLng] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const rideSubmitLock = useRef(false);
  const [error, setError] = useState("");

  // Phase 2.5: Safety features state
  const [showTOSModal, setShowTOSModal] = useState(false);
  const [hasConsent, setHasConsent] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [cooldownStatus, setCooldownStatus] = useState<CooldownStatus | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  // Phase 3: Batch position state
  const [batchPosition, setBatchPosition] = useState<{
    batch_id: string;
    position: number;
    total_stops: number;
    estimated_arrival: string | null;
  } | null>(null);

  const [isEditingRide, setIsEditingRide] = useState(false);

  // Check initial code
  useEffect(() => {
    if (initialCode) {
      handleCodeSubmit();
    }
  }, []);

  // Client-side rehydration uses the unguessable capability returned by the
  // server, not a phone number (which is contact data, not authentication).
  useEffect(() => {
    const tryRehydrate = async () => {
      try {
        const stored = localStorage.getItem("ralli_ride_id");
        const storedAccessToken = localStorage.getItem("ralli_ride_access_token");
        if (!stored) return;

        if (!storedAccessToken) {
          localStorage.removeItem("ralli_ride_id");
          return;
        }

        const { data, error } = await getRideRequestById(stored, {
          access_token: storedAccessToken,
        });

        if (error || !data) {
          localStorage.removeItem("ralli_ride_id");
          return;
        }

        // If ride is still active, set and show status
        if (["waiting", "assigned", "arrived", "in_progress"].includes(data.ride.status)) {
          setRideAccessToken(storedAccessToken);
          applyRideStatus(data);
          setStep("status");
        } else {
          localStorage.removeItem("ralli_ride_id");
          localStorage.removeItem("ralli_ride_access_token");
          setRideAccessToken(null);
        }
      } catch (err) {
        // ignore
      }
    };

    tryRehydrate();
  }, [clientId]);

  // Get user location for emergency reporting
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setUserLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
        },
        (err) => {
          console.log("Location access denied:", err);
        }
      );
    }
  }, []);

  // Ensure a persistent client id in localStorage for stable identification when phone isn't available
  useEffect(() => {
    try {
      let cid = localStorage.getItem("ralli_client_id");
      if (!cid) {
        // Prefer browser crypto.randomUUID when available
        const newCid = (typeof crypto !== "undefined" && (crypto as any).randomUUID)
          ? (crypto as any).randomUUID()
          : `c_${Math.random().toString(36).slice(2)}_${Date.now()}`;
      localStorage.setItem("ralli_client_id", newCid);
        cid = newCid;
      }
      setClientId(cid);
    } catch (err) {
      // ignore storage errors
    }
  }, []);

  // Apply a ride status payload from the API (ride + queue + batch + driver).
  const applyRideStatus = useCallback(
    (payload: {
      ride: RideRequest;
      position: number;
      total: number;
      batch: {
        batch_id: string;
        position: number;
        total_stops: number;
        estimated_arrival: string | null;
      } | null;
    }) => {
      setRideRequest(payload.ride);
      setQueuePosition({ position: payload.position, total: payload.total });
      setBatchPosition(payload.batch);

      const lat = payload.ride.driver?.current_lat;
      const lng = payload.ride.driver?.current_lng;
      if (lat != null && lng != null) {
        setDriverLocation({ lat, lng });
      }
    },
    []
  );

  // Poll for ride updates. Supabase Realtime enforces RLS, so an
  // unauthenticated rider cannot subscribe to ride_requests now that the
  // public SELECT policy is gone. Polling the service-role route instead.
  useEffect(() => {
    if (!rideRequest) return;

    // Nothing left to wait for - stop polling entirely.
    if (["completed", "cancelled", "no_show"].includes(rideRequest.status)) return;

    let cancelled = false;

    const load = async () => {
      // Don't poll tabs the rider isn't looking at.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      const { data } = await getRideRequestById(rideRequest.id, {
        access_token: rideAccessToken,
      });
      if (!cancelled && data) applyRideStatus(data);
    };

    const timer = setInterval(load, RIDE_POLL_MS);

    // Refresh immediately when the rider comes back to the tab.
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rideRequest?.id, rideRequest?.status, rideAccessToken, applyRideStatus]);

  const handleCodeSubmit = async () => {
    if (!accessCode.trim()) {
      setError("Please enter an access code");
      return;
    }

    setIsLoading(true);
    setError("");

    const { data, error: fetchError } = await getEventByAccessCode(accessCode);

    if (fetchError || !data) {
      setError("Invalid or inactive access code");
      setIsLoading(false);
      return;
    }

    setEvent(data);

    // If event has location, pre-fill dropoff and set default direction to "to_event"
    if (data.event_address && data.event_lat && data.event_lng) {
      setDropoffAddress(data.event_address);
      setDropoffLat(data.event_lat);
      setDropoffLng(data.event_lng);
      setRideDirection("to_event");
    }

    setStep("form");
    setIsLoading(false);
  };

  // Check TOS consent and cooldown when name changes
  const checkRiderStatus = useCallback(async () => {
    if (!event || !riderName.trim() || !clientId) return;

    try {
      const resp = await fetch("/api/rider/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: event.id, client_id: clientId }),
      });
      const json = await resp.json();
      if (resp.ok) setHasConsent(!!json.has_consent);
    } catch (err) {
      console.error("Failed to identify rider:", err);
    }
  }, [event, riderName, clientId]);

  useEffect(() => {
    const timer = setTimeout(checkRiderStatus, 500);
    return () => clearTimeout(timer);
  }, [checkRiderStatus]);

  // Handle TOS acceptance
  const handleTOSAccept = async () => {
    if (!event) return;

    setIsLoading(true);
    await recordConsent(event.id, { rider_phone: riderPhone, client_id: clientId });
    setHasConsent(true);
    setShowTOSModal(false);
    setIsLoading(false);
  };

  // Persist the ride id plus the phone. The phone is required because
  // GET /api/rides/[id] only returns a ride to a caller who can prove they
  // own it, and the identifier is derived from the phone.
  const persistRide = ({ id, accessToken }: { id: string; accessToken: string }) => {
    try {
      localStorage.setItem("ralli_ride_id", id);
      localStorage.setItem("ralli_ride_access_token", accessToken);
      setRideAccessToken(accessToken);
    } catch {}
  };

  // Handle "I'm Here" confirmation
  const handleConfirmPresence = async () => {
    if (!rideRequest) return;

    setIsConfirming(true);
    const { success, error } = await confirmRiderPresence(rideRequest.id, {
      access_token: rideAccessToken,
    });

    if (success) {
      // Ride will transition to in_progress via realtime subscription
    } else {
      console.error("Failed to confirm presence:", error);
    }
    setIsConfirming(false);
  };

  // Handle emergency trigger
  const handleEmergency = async () => {
    if (!event || !rideRequest) return;

    await triggerEmergency(
      event.id,
      rideRequest.id,
      "rider",
      riderName || "Unknown Rider",
      userLocation?.lat,
      userLocation?.lng,
      { access_token: rideAccessToken }
    );
  };

  // Handle cancel ride
  const handleCancelRide = async () => {
    if (!rideRequest) return;

    if (!window.confirm("Are you sure you want to cancel this ride?")) {
      return;
    }

    setIsConfirming(true);
    const { error } = await cancelRideRequest(rideRequest.id, {
      access_token: rideAccessToken,
    });

    if (error) {
      setError("Failed to cancel ride");
      console.error("Cancel ride error:", error);
    } else {
      // Clear the ride from state and localStorage
      setRideRequest(null);
      setQueuePosition({ position: 0, total: 0 });
      setBatchPosition(null);
      setDriverLocation(null);
      try {
        localStorage.removeItem("ralli_ride_id");
        localStorage.removeItem("ralli_ride_access_token");
      } catch {}
      setRideAccessToken(null);
      setStep("form");
    }
    setIsConfirming(false);
  };

  // Handle edit ride
  const handleEditRide = () => {
    if (!rideRequest) return;

    // Pre-fill form with current ride data
    setRiderName(rideRequest.rider_name);
    setRiderPhone(rideRequest.rider_phone || "");
    setPickupAddress(rideRequest.pickup_address);
    setPickupLat(rideRequest.pickup_lat);
    setPickupLng(rideRequest.pickup_lng);
    setPassengerCount(rideRequest.passenger_count);
    if (rideRequest.dropoff_address) {
      setDropoffAddress(rideRequest.dropoff_address);
      setDropoffLat(rideRequest.dropoff_lat || 0);
      setDropoffLng(rideRequest.dropoff_lng || 0);
    }

    setIsEditingRide(true);
    setStep("form");
  };

  const handleRideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rideSubmitLock.current) return;

    try {
      if (passengerCount < 1 || passengerCount > 4) {
        setError("Passenger count must be between 1 and 4");
        return;
      }

      if (!pickupAddress.trim()) {
        setError("Please enter a pickup address");
        return;
      }

      // If event has location, validate dropoff address
      if (event?.event_address && !dropoffAddress.trim()) {
        setError("Please enter a dropoff address");
        return;
      }

      if (!riderPhone.trim()) {
        setError("Phone number is required");
        return;
      }
      const phoneDigits = riderPhone.replace(/\D/g, "");
      if (phoneDigits.length < 10) {
        setError("Please enter a valid phone number (at least 10 digits)");
        return;
      }

      // Check if rider needs to accept TOS first
      if (!hasConsent) {
        setShowTOSModal(true);
        return;
      }

      // Check cooldown
      if (cooldownStatus?.is_in_cooldown) {
        setError("You are in a cooldown period. Please wait before requesting another ride.");
        return;
      }

      // Check if requests are open (event starts in 15 mins or already started)
      if (event?.start_time) {
        const now = new Date();
        const eventStart = new Date(event.start_time);
        const requestsOpenTime = new Date(eventStart.getTime() - 15 * 60000); // 15 mins before start

        if (now < requestsOpenTime) {
          const timeUntilOpen = Math.ceil((requestsOpenTime.getTime() - now.getTime()) / 60000);
          const eventStartStr = eventStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const requestsOpenStr = requestsOpenTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          setError(`Event starts at ${eventStartStr}. Ride requests open at ${requestsOpenStr} (${timeUntilOpen} minutes from now).`);
          return;
        }
      }

      rideSubmitLock.current = true;
      setIsLoading(true);
      setError("");

    // For MVP, use a default location if geocoding not set up
    const lat = pickupLat || 40.7128;
    const lng = pickupLng || -74.006;

    // If editing an existing ride, update it instead of creating new
    if (isEditingRide && rideRequest) {
      const { data, error } = await updateRideRequest(rideRequest.id, {
        pickup_address: pickupAddress,
        pickup_lat: lat,
        pickup_lng: lng,
        passenger_count: passengerCount,
        ...(event?.event_address && dropoffAddress && {
          dropoff_address: dropoffAddress,
          dropoff_lat: dropoffLat,
          dropoff_lng: dropoffLng,
        }),
      },
      {
        access_token: rideAccessToken,
      });

      if (error) {
        setError("Failed to update ride");
        setIsLoading(false);
        return;
      }

      if (data) {
        const status = await getRideRequestById(data.id, { access_token: rideAccessToken });
        if (status.data) applyRideStatus(status.data);
        setIsEditingRide(false);
        setStep("status");
        setIsLoading(false);
      }
      return;
    }

    // Call server API to create ride idempotently
    const payload: any = {
      event_id: event!.id,
      rider_name: riderName,
      rider_phone: riderPhone.trim(),
      pickup_address: pickupAddress,
      pickup_lat: lat,
      pickup_lng: lng,
      passenger_count: passengerCount,
    };

    const storedAccessToken = rideAccessToken || localStorage.getItem("ralli_ride_access_token");
    if (storedAccessToken) payload.access_token = storedAccessToken;

    // Add direction and dropoff if event has location
    if (event?.event_address && dropoffAddress) {
      payload.ride_direction = rideDirection;
      payload.dropoff_address = dropoffAddress;
      payload.dropoff_lat = dropoffLat;
      payload.dropoff_lng = dropoffLng;
    }

    const resp = await fetch(`/api/rides`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await resp.json();
    console.log("Ride API response:", { status: resp.status, isExisting: json.isExisting, hasData: !!json.data, error: json.error });

    // Check if this is an existing ride (Option A implementation)
    if (json.isExisting && json.data) {
      console.log("Found existing ride, showing it directly");
      const existingRide = json.data as RideRequest;
      setRideRequest(existingRide);
      setError(""); // Clear any prior error

      if (!json.access_token) {
        setError("Ride access could not be restored. Please use the device that created this ride.");
        setIsLoading(false);
        return;
      }
      persistRide({ id: existingRide.id, accessToken: json.access_token });

      // Queue position comes from the status payload
      const status = await getRideRequestById(existingRide.id, {
        access_token: json.access_token,
      });
      if (status.data) applyRideStatus(status.data);

      setStep("status");
      setIsLoading(false);
      return;
    }

    if (json.isExisting && !json.data) {
      setError(json.message || "An active ride exists. Reopen the device used to request it.");
      setIsLoading(false);
      return;
    }

    if (!resp.ok || json.error) {
      if (json.cooldown) setCooldownStatus(json.cooldown);
      setError(json.error || "Failed to create ride request");
      setIsLoading(false);
      return;
    }

    const data = json.data;
    const accessToken = json.access_token;
    if (!data?.id || !accessToken) {
      setError("The ride was created but its access token was not returned. Contact the event admin before submitting again.");
      setIsLoading(false);
      return;
    }

    setRideRequest(data as RideRequest);
    setError(""); // Clear any prior error

    persistRide({ id: data.id, accessToken });

    // Queue position comes from the status payload
    const status = await getRideRequestById(data.id, {
      access_token: accessToken,
    });
    if (status.data) applyRideStatus(status.data);

    setStep("status");
    setIsLoading(false);
    } catch (err) {
      console.error("Error submitting ride:", err);
      setError((err as Error).message || "An unexpected error occurred");
      setIsLoading(false);
    } finally {
      rideSubmitLock.current = false;
    }
  };

  // Access Code Entry
  if (step === "code") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 rounded-full bg-primary-900/50 flex items-center justify-center">
                <Car className="h-8 w-8 text-primary-400" />
              </div>
            </div>
            <h1 className="text-2xl font-bold">Request a Ride</h1>
            <p className="text-dark-400 mt-2">Enter your event access code</p>
          </div>

          <div className="space-y-4">
            <Input
              value={accessCode}
              onChange={(e) => {
                setAccessCode(e.target.value.toUpperCase());
                setError("");
              }}
              placeholder="ACCESS CODE"
              className="text-center text-lg tracking-widest uppercase"
              maxLength={6}
              error={error}
            />
            <Button
              onClick={handleCodeSubmit}
              className="w-full"
              isLoading={isLoading}
            >
              Continue
            </Button>
          </div>

          <div className="text-center">
            <a href="/" className="text-sm text-dark-500 hover:text-dark-300">
              ← Back to home
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Ride Request Form
  if (step === "form") {
    return (
      <div className="min-h-screen bg-dark-950 py-8 px-4">
        <div className="max-w-md mx-auto">
          <button
            onClick={() => {
              setStep(isEditingRide ? "status" : "code");
              setIsEditingRide(false);
            }}
            className="flex items-center gap-2 text-dark-400 hover:text-dark-200 mb-6"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          {/* Cooldown Notice */}
          {cooldownStatus?.is_in_cooldown && (
            <div className="mb-6">
              <CooldownNotice cooldownStatus={cooldownStatus} />
            </div>
          )}

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Request a Ride</CardTitle>
                  <p className="text-sm text-dark-400 mt-1">{event?.event_name}</p>
                </div>
                <Badge variant="available">Active</Badge>
              </div>
            </CardHeader>

            <CardContent>
              <form onSubmit={handleRideSubmit} className="space-y-4">
                <Input
                  label="Your Name"
                  value={riderName}
                  onChange={(e) => setRiderName(e.target.value)}
                  placeholder="John Smith"
                  required
                />

                <Input
                  label="Phone Number"
                  type="tel"
                  value={riderPhone}
                  onChange={(e) => setRiderPhone(e.target.value)}
                  placeholder="(555) 123-4567"
                  required
                />

                {/* Ride Direction Selector - show if event has location */}
                {event?.event_address && (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium">Ride Direction</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setRideDirection("to_event");
                          // Auto-fill dropoff with event location
                          setDropoffAddress(event.event_address!);
                          setDropoffLat(event.event_lat!);
                          setDropoffLng(event.event_lng!);
                          // Clear pickup for user to enter
                          setPickupAddress("");
                          setPickupLat(0);
                          setPickupLng(0);
                        }}
                        className={`p-3 rounded-lg border ${
                          rideDirection === "to_event"
                            ? "border-primary-500 bg-primary-900/30"
                            : "border-dark-700"
                        }`}
                      >
                        <div className="text-sm font-medium">To Event</div>
                        <div className="text-xs text-dark-400">Pick me up → Event</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRideDirection("from_event");
                          // Auto-fill pickup with event location
                          setPickupAddress(event.event_address!);
                          setPickupLat(event.event_lat!);
                          setPickupLng(event.event_lng!);
                          // Clear dropoff for user to enter
                          setDropoffAddress("");
                          setDropoffLat(0);
                          setDropoffLng(0);
                        }}
                        className={`p-3 rounded-lg border ${
                          rideDirection === "from_event"
                            ? "border-primary-500 bg-primary-900/30"
                            : "border-dark-700"
                        }`}
                      >
                        <div className="text-sm font-medium">From Event</div>
                        <div className="text-xs text-dark-400">Event → Drop me off</div>
                      </button>
                    </div>
                  </div>
                )}

                {/* Pickup Address - editable if to_event OR no event location */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-1">
                    {event?.event_address && rideDirection === "from_event"
                      ? "Pickup Location (Event)"
                      : "Pickup Address"}
                  </label>
                  {event?.event_address && rideDirection === "from_event" ? (
                    <div className="p-3 bg-dark-800 rounded-lg border border-dark-700 text-dark-400 text-sm">
                      <MapPin className="h-4 w-4 inline mr-2" />
                      {pickupAddress}
                    </div>
                  ) : (
                    <PlacesAutocomplete
                      value={pickupAddress}
                      onChange={setPickupAddress}
                      onPlaceSelect={(place) => {
                        setPickupAddress(place.address);
                        setPickupLat(place.lat);
                        setPickupLng(place.lng);
                      }}
                      placeholder="Start typing an address..."
                    />
                  )}
                </div>

                {/* Dropoff Address - show if event has location */}
                {event?.event_address && (
                  <div>
                    <label className="block text-sm font-medium text-dark-300 mb-1">
                      {rideDirection === "to_event"
                        ? "Dropoff Location (Event)"
                        : "Dropoff Address"}
                    </label>
                    {rideDirection === "to_event" ? (
                      <div className="p-3 bg-dark-800 rounded-lg border border-dark-700 text-dark-400 text-sm">
                        <MapPin className="h-4 w-4 inline mr-2" />
                        {dropoffAddress}
                      </div>
                    ) : (
                      <PlacesAutocomplete
                        value={dropoffAddress}
                        onChange={setDropoffAddress}
                        onPlaceSelect={(place) => {
                          setDropoffAddress(place.address);
                          setDropoffLat(place.lat);
                          setDropoffLng(place.lng);
                        }}
                        placeholder="Start typing an address..."
                      />
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-1">
                    Number of Passengers
                  </label>
                  <div className="flex gap-2">
                    {[1, 2, 3, 4].map((num) => (
                      <button
                        key={num}
                        type="button"
                        onClick={() => setPassengerCount(num)}
                        className={`flex-1 py-3 rounded-lg border transition-colors ${
                          passengerCount === num
                            ? "border-primary-500 bg-primary-900/30 text-primary-300"
                            : "border-dark-700 bg-dark-800 text-dark-300 hover:border-dark-600"
                        }`}
                      >
                        {num}
                      </button>
                    ))}
                  </div>
                </div>

                {error && <p className="text-sm text-red-400">{error}</p>}

                <Button
                  type="submit"
                  className="w-full"
                  isLoading={isLoading}
                  disabled={cooldownStatus?.is_in_cooldown}
                >
                  {isEditingRide ? "Update Ride" : "Request Ride"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* TOS Modal */}
        {showTOSModal && (
          <TOSModal
            onAccept={handleTOSAccept}
            onClose={() => setShowTOSModal(false)}
            isLoading={isLoading}
            eventName={event?.event_name}
          />
        )}
      </div>
    );
  }

  // Ride Status
  return (
    <div className="min-h-screen bg-dark-950 py-8 px-4">
      <div className="max-w-md mx-auto space-y-6">
        <div className="text-center">
          <Car className="h-10 w-10 text-primary-400 mx-auto mb-2" />
          <h1 className="text-xl font-bold">{event?.event_name}</h1>
        </div>

        {/* Status Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Your Ride</CardTitle>
              <RideStatusBadge status={rideRequest?.status || "waiting"} />
            </div>
          </CardHeader>

          <CardContent className="space-y-6">
            {/* Waiting Status */}
            {rideRequest?.status === "waiting" && (
              <div className="text-center py-6">
                <div className="w-20 h-20 rounded-full bg-yellow-900/30 flex items-center justify-center mx-auto mb-4">
                  <Clock className="h-10 w-10 text-yellow-400 animate-pulse" />
                </div>
                <h3 className="text-lg font-semibold">Waiting in Queue</h3>
                <p className="text-4xl font-bold text-primary-400 my-2">
                  #{queuePosition.position}
                </p>
                <p className="text-sm text-dark-400">
                  of {queuePosition.total} in queue
                </p>
                {rideRequest.estimated_wait_minutes && (
                  <div className="mt-4 flex items-center justify-center gap-2 text-dark-300">
                    <Timer className="h-4 w-4" />
                    <span>Estimated wait: ~{rideRequest.estimated_wait_minutes} min</span>
                  </div>
                )}
              </div>
            )}

            {/* Assigned Status */}
            {rideRequest?.status === "assigned" && (
              <div className="text-center py-6">
                <div className="w-20 h-20 rounded-full bg-blue-900/30 flex items-center justify-center mx-auto mb-4">
                  <Car className="h-10 w-10 text-blue-400" />
                </div>
                <h3 className="text-lg font-semibold">Driver Assigned!</h3>
                <p className="text-dark-400 mt-2">
                  {rideRequest?.driver?.profile?.full_name || "Your driver"} is on the way
                </p>
                {rideRequest.driver_eta_minutes && (
                  <div className="mt-4 bg-cyan-900/20 rounded-lg px-4 py-2 inline-flex items-center gap-2">
                    <Timer className="h-4 w-4 text-cyan-400" />
                    <span className="text-cyan-400 font-medium">
                      ETA: {formatETA(rideRequest.driver_eta_minutes)}
                    </span>
                  </div>
                )}

                {/* Batch position info */}
                {batchPosition && batchPosition.total_stops > 1 && (
                  <div className="mt-4">
                    <BatchPosition
                      position={batchPosition.position}
                      totalStops={batchPosition.total_stops}
                      estimatedArrival={batchPosition.estimated_arrival}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Arrived Status */}
            {rideRequest?.status === "arrived" && (
              <div className="text-center py-6">
                <div className="w-20 h-20 rounded-full bg-cyan-900/30 flex items-center justify-center mx-auto mb-4">
                  <MapPinned className="h-10 w-10 text-cyan-400 animate-bounce" />
                </div>
                <h3 className="text-lg font-semibold">Driver Has Arrived!</h3>
                <p className="text-dark-400 mt-2">
                  {rideRequest?.driver?.profile?.full_name || "Your driver"} is waiting at your pickup location
                </p>

                {/* No-show countdown */}
                {rideRequest.arrival_deadline_timestamp && !rideRequest.rider_confirmed && (
                  <div className="mt-6 p-4 bg-dark-800/50 rounded-lg">
                    <NoShowCountdown
                      arrivalDeadlineTimestamp={rideRequest.arrival_deadline_timestamp}
                      onExpired={() => {
                        // Refresh ride status when expired
                        getRideRequestById(rideRequest.id, {
                          access_token: rideAccessToken,
                        }).then(({ data }) => {
                          if (data) applyRideStatus(data);
                        });
                      }}
                    />
                    <Button
                      variant="success"
                      size="lg"
                      className="mt-4 w-full"
                      onClick={handleConfirmPresence}
                      isLoading={isConfirming}
                    >
                      <Hand className="h-5 w-5 mr-2" />
                      I&apos;m Here
                    </Button>
                  </div>
                )}

                {rideRequest.rider_confirmed && (
                  <p className="text-sm text-green-400 mt-4">
                    <CheckCircle className="h-4 w-4 inline mr-1" />
                    Presence confirmed!
                  </p>
                )}
              </div>
            )}

            {/* In Progress Status */}
            {rideRequest?.status === "in_progress" && (
              <div className="text-center py-6">
                <div className="w-20 h-20 rounded-full bg-purple-900/30 flex items-center justify-center mx-auto mb-4">
                  <Navigation className="h-10 w-10 text-purple-400 animate-pulse" />
                </div>
                <h3 className="text-lg font-semibold">Ride in Progress</h3>
                <p className="text-dark-400 mt-2">Enjoy your ride!</p>
              </div>
            )}

            {/* Completed Status */}
            {rideRequest?.status === "completed" && (
              <div className="text-center py-6">
                <div className="w-20 h-20 rounded-full bg-green-900/30 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="h-10 w-10 text-green-400" />
                </div>
                <h3 className="text-lg font-semibold">Ride Complete!</h3>
                <p className="text-dark-400 mt-2">Thanks for using Ralli</p>
                <Button
                  variant="secondary"
                  className="mt-4"
                  onClick={() => {
                    setStep("form");
                    setRideRequest(null);
                    setRideAccessToken(null);
                    setRiderName("");
                    setRiderPhone("");
                    setPickupAddress("");
                    setPassengerCount(1);
                    try {
                      localStorage.removeItem("ralli_ride_id");
                      localStorage.removeItem("ralli_ride_access_token");
                    } catch {}
                  }}
                >
                  Request Another Ride
                </Button>
              </div>
            )}

            {/* Ride Details */}
            {rideRequest && rideRequest.status !== "completed" && (
              <div className="border-t border-dark-800 pt-4 space-y-3">
                <div className="flex items-center gap-3">
                  <Users className="h-5 w-5 text-dark-500" />
                  <span>{rideRequest.passenger_count} passenger(s)</span>
                </div>
                <div className="flex items-start gap-3">
                  <MapPin className="h-5 w-5 text-blue-500 shrink-0" />
                  <div>
                    <div className="text-xs text-dark-400">Pickup</div>
                    <span>{rideRequest.pickup_address}</span>
                  </div>
                </div>
                {rideRequest.dropoff_address && (
                  <div className="flex items-start gap-3">
                    <MapPinned className="h-5 w-5 text-green-500 shrink-0" />
                    <div>
                      <div className="text-xs text-dark-400">Dropoff</div>
                      <span>{rideRequest.dropoff_address}</span>
                    </div>
                  </div>
                )}
                {rideRequest?.driver?.profile && (
                  <div className="flex items-center gap-3 text-primary-400">
                    <Car className="h-5 w-5" />
                    <span>Driver: {rideRequest.driver.profile.full_name}</span>
                  </div>
                )}

                {/* Edit Ride Button - only before driver assigned */}
                {rideRequest.status === "waiting" && (
                  <div className="border-t border-dark-800 pt-3">
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={handleEditRide}
                    >
                      Edit Ride
                    </Button>
                  </div>
                )}

                {/* Cancel Ride Button - show for cancellable statuses */}
                {["waiting", "assigned", "arrived"].includes(rideRequest.status) && (
                  <div className="border-t border-dark-800 pt-3">
                    <Button
                      variant="ghost"
                      className="w-full text-red-400 hover:text-red-300"
                      onClick={handleCancelRide}
                      isLoading={isConfirming}
                    >
                      Cancel Ride
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Driver Location Map */}
        {driverLocation && (rideRequest?.status === "assigned" || rideRequest?.status === "arrived") && rideRequest.pickup_lat && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-dark-400">
              <Navigation className="h-4 w-4 text-primary-400" />
              <span>
                {rideRequest.status === "assigned"
                  ? "Driver is on the way to your location"
                  : "Driver is at your pickup location"}
              </span>
            </div>
            <DriverLocationMap
              driverLat={driverLocation.lat}
              driverLng={driverLocation.lng}
              pickupLat={rideRequest.pickup_lat}
              pickupLng={rideRequest.pickup_lng}
            />
          </Card>
        )}

        <p className="text-center text-xs text-dark-500">
          Ride ID: {rideRequest?.id.slice(0, 8)}...
        </p>
      </div>

      {/* Emergency Button - show during active ride states */}
      {rideRequest &&
        ["assigned", "arrived", "in_progress"].includes(rideRequest.status) && (
          <EmergencyButton onTrigger={handleEmergency} />
        )}

    </div>
  );
}

export default function RiderPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        </div>
      }
    >
      <RiderContent />
    </Suspense>
  );
}
