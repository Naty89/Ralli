"use client";

import { useState, useEffect, Suspense, useCallback } from "react";
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
  AlertTriangle,
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
import {
  createRideRequest,
  getRideRequestById,
  getQueuePosition,
  subscribeToRideRequest,
} from "@/lib/services/rides";
import { subscribeToDriver } from "@/lib/services/drivers";
import { formatETA } from "@/lib/services/etaService";
import {
  generateRiderIdentifierHash,
  checkConsent,
  recordConsent,
} from "@/lib/services/consentService";
import { getCooldownStatus, confirmRiderPresence } from "@/lib/services/safetyService";
import { triggerEmergency } from "@/lib/services/emergencyService";
import { getRideBatchPosition } from "@/lib/services/batchService";
import { Event, RideRequest, Driver, CooldownStatus } from "@/types/database";

function RiderContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialCode = searchParams.get("code") || "";

  const [step, setStep] = useState<"code" | "form" | "status">("code");
  const [accessCode, setAccessCode] = useState(initialCode);
  const [event, setEvent] = useState<Event | null>(null);
  const [rideRequest, setRideRequest] = useState<RideRequest | null>(null);
  const [queuePosition, setQueuePosition] = useState({ position: 0, total: 0 });
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);

  // Form state
  const [riderName, setRiderName] = useState("");
  const [pickupAddress, setPickupAddress] = useState("");
  const [pickupLat, setPickupLat] = useState(0);
  const [pickupLng, setPickupLng] = useState(0);
  const [passengerCount, setPassengerCount] = useState(1);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // Phase 2.5: Safety features state
  const [showTOSModal, setShowTOSModal] = useState(false);
  const [hasConsent, setHasConsent] = useState(false);
  const [riderHash, setRiderHash] = useState("");
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

  // Check initial code
  useEffect(() => {
    if (initialCode) {
      handleCodeSubmit();
    }
  }, []);

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

  // Subscribe to ride updates
  useEffect(() => {
    if (!rideRequest) return;

    const sub = subscribeToRideRequest(rideRequest.id, async () => {
      const { data } = await getRideRequestById(rideRequest.id);
      if (data) {
        setRideRequest(data);

        // Update queue position
        if (data.status === "waiting" && event) {
          const pos = await getQueuePosition(data.id, event.id);
          setQueuePosition(pos);
        }

        // Update batch position if in a batch
        if (data.batch_id) {
          const { data: batchPos } = await getRideBatchPosition(data.id);
          setBatchPosition(batchPos);
        }
      }
    });

    return () => {
      sub.unsubscribe();
    };
  }, [rideRequest?.id]);

  // Subscribe to driver location when assigned
  useEffect(() => {
    if (!rideRequest?.assigned_driver_id) return;

    const sub = subscribeToDriver(rideRequest.assigned_driver_id, (payload: any) => {
      const driver = payload.new as Driver;
      if (driver.current_lat && driver.current_lng) {
        setDriverLocation({ lat: driver.current_lat, lng: driver.current_lng });
      }
    });

    return () => {
      sub.unsubscribe();
    };
  }, [rideRequest?.assigned_driver_id]);

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
    setStep("form");
    setIsLoading(false);
  };

  // Check TOS consent and cooldown when name changes
  const checkRiderStatus = useCallback(async () => {
    if (!event || !riderName.trim()) return;

    // Generate hash (using placeholder IP for now - in production, get from API)
    const hash = await generateRiderIdentifierHash(
      event.id,
      riderName.trim(),
      "client-ip" // In production, fetch actual IP from an API route
    );
    setRiderHash(hash);

    // Check consent
    const { hasConsent: consent } = await checkConsent(event.id, hash);
    setHasConsent(consent);

    // Check cooldown
    const { data: cooldown } = await getCooldownStatus(event.id, hash);
    setCooldownStatus(cooldown);
  }, [event, riderName]);

  useEffect(() => {
    const timer = setTimeout(checkRiderStatus, 500);
    return () => clearTimeout(timer);
  }, [checkRiderStatus]);

  // Handle TOS acceptance
  const handleTOSAccept = async () => {
    if (!event || !riderHash) return;

    setIsLoading(true);
    await recordConsent(event.id, riderHash);
    setHasConsent(true);
    setShowTOSModal(false);
    setIsLoading(false);
  };

  // Handle "I'm Here" confirmation
  const handleConfirmPresence = async () => {
    if (!rideRequest) return;

    setIsConfirming(true);
    const { success, error } = await confirmRiderPresence(rideRequest.id);

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
      userLocation?.lng
    );
  };

  const handleRideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (passengerCount < 1 || passengerCount > 4) {
      setError("Passenger count must be between 1 and 4");
      return;
    }

    if (!pickupAddress.trim()) {
      setError("Please enter a pickup address");
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

    setIsLoading(true);
    setError("");

    // For MVP, use a default location if geocoding not set up
    const lat = pickupLat || 40.7128;
    const lng = pickupLng || -74.006;

    const { data, error: createError } = await createRideRequest({
      event_id: event!.id,
      rider_name: riderName,
      pickup_address: pickupAddress,
      pickup_lat: lat,
      pickup_lng: lng,
      passenger_count: passengerCount,
      rider_identifier_hash: riderHash,
    });

    if (createError || !data) {
      setError(createError?.message || "Failed to create ride request");
      setIsLoading(false);
      return;
    }

    setRideRequest(data);

    // Get initial queue position
    const pos = await getQueuePosition(data.id, event!.id);
    setQueuePosition(pos);

    setStep("status");
    setIsLoading(false);
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
            onClick={() => setStep("code")}
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

                <PlacesAutocomplete
                  label="Pickup Address"
                  value={pickupAddress}
                  onChange={setPickupAddress}
                  onPlaceSelect={(place) => {
                    setPickupAddress(place.address);
                    setPickupLat(place.lat);
                    setPickupLng(place.lng);
                  }}
                  placeholder="Start typing an address..."
                />

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
                  Request Ride
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
                        getRideRequestById(rideRequest.id).then(({ data }) => {
                          if (data) setRideRequest(data);
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
                    setRiderName("");
                    setPickupAddress("");
                    setPassengerCount(1);
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
                  <MapPin className="h-5 w-5 text-dark-500 shrink-0" />
                  <span>{rideRequest.pickup_address}</span>
                </div>
                {rideRequest?.driver?.profile && (
                  <div className="flex items-center gap-3 text-primary-400">
                    <Car className="h-5 w-5" />
                    <span>Driver: {rideRequest.driver.profile.full_name}</span>
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
