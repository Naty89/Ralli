"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import {
  Car,
  ArrowLeft,
  Users,
  Clock,
  CheckCircle,
  XCircle,
  UserPlus,
  RefreshCw,
  MapPin,
  Copy,
  Zap,
  BarChart3,
  AlertTriangle,
  Timer,
  Layers,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Badge, RideStatusBadge, DriverStatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/lib/services/auth";
import { getEventById, updateEvent } from "@/lib/services/events";
import {
  getEventRideRequests,
  subscribeToRideRequests,
} from "@/lib/services/rides";
import {
  getEventDrivers,
  subscribeToDrivers,
  getAvailableDriverProfiles,
  addDriverToEvent,
  removeDriverFromEvent,
} from "@/lib/services/drivers";
import {
  dispatchAllRides,
  transitionRideStatus,
  assignDriverToRide,
} from "@/lib/services/dispatchService";
import { getEventAnalytics } from "@/lib/services/analyticsService";
import { formatETA } from "@/lib/services/etaService";
import {
  getActiveEmergencies,
  resolveEmergency,
  subscribeToEmergencies,
} from "@/lib/services/emergencyService";
import { batchDispatch } from "@/lib/services/batchService";
import { Event, RideRequest, Driver, Profile, EventAnalytics, EmergencyEvent } from "@/types/database";

export default function AdminEventPage() {
  const params = useParams();
  const eventId = params.id as string;
  const router = useRouter();
  const [event, setEvent] = useState<Event | null>(null);
  const [rides, setRides] = useState<RideRequest[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [autoAssign, setAutoAssign] = useState(false);
  const [isAutoAssigning, setIsAutoAssigning] = useState(false);
  const [analytics, setAnalytics] = useState<EventAnalytics | null>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);

  // Phase 2.5: Emergency state
  const [emergencies, setEmergencies] = useState<EmergencyEvent[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);

  // Phase 3: Batch mode state
  const [batchMode, setBatchMode] = useState(false);
  const [isBatchDispatching, setIsBatchDispatching] = useState(false);

  // Add driver modal state
  const [showAddDriverModal, setShowAddDriverModal] = useState(false);
  const [availableDriverProfiles, setAvailableDriverProfiles] = useState<Profile[]>([]);

  useEffect(() => {
    loadData();

    // Set up realtime subscriptions
    const ridesSub = subscribeToRideRequests(eventId, () => {
      loadRides();
    });

    const driversSub = subscribeToDrivers(eventId, () => {
      loadDrivers();
    });

    // Subscribe to emergencies
    const emergencySub = subscribeToEmergencies(eventId, () => {
      loadEmergencies();
    });

    return () => {
      ridesSub.unsubscribe();
      driversSub.unsubscribe();
      emergencySub.unsubscribe();
    };
  }, [eventId]);

  // Auto-assign effect: runs when auto-assign is enabled and rides/drivers change
  useEffect(() => {
    if (autoAssign && !isAutoAssigning) {
      runAutoAssign();
    }
  }, [autoAssign, rides, drivers]);

  const runAutoAssign = async () => {
    setIsAutoAssigning(true);
    if (batchMode) {
      await batchDispatch(eventId);
    } else {
      await dispatchAllRides(eventId);
    }
    await loadRides();
    await loadDrivers();
    setIsAutoAssigning(false);
  };

  const loadEmergencies = async () => {
    const { data } = await getActiveEmergencies(eventId);
    setEmergencies(data || []);
  };

  const handleResolveEmergency = async (emergencyId: string) => {
    if (!profile) return;
    await resolveEmergency(emergencyId, profile.id);
    await loadEmergencies();
  };

  const toggleBatchMode = async () => {
    const newValue = !batchMode;
    setBatchMode(newValue);
    // Persist to event settings
    await updateEvent(eventId, { batch_mode_enabled: newValue });
  };

  const loadAnalytics = async () => {
    const { data } = await getEventAnalytics(eventId);
    setAnalytics(data);
  };

  const loadData = async () => {
    const { profile: userProfile, error } = await getCurrentUser();
    if (error || !userProfile) {
      router.push("/admin/login");
      return;
    }
    setProfile(userProfile);

    const { data: eventData } = await getEventById(eventId);
    if (!eventData) {
      router.push("/admin/dashboard");
      return;
    }
    setEvent(eventData);
    setBatchMode(eventData.batch_mode_enabled || false);

    await loadRides();
    await loadDrivers();
    await loadAnalytics();
    await loadEmergencies();
    setIsLoading(false);
  };

  const loadRides = async () => {
    const { data } = await getEventRideRequests(eventId);
    setRides(data);
  };

  const loadDrivers = async () => {
    const { data } = await getEventDrivers(eventId);
    setDrivers(data);
  };

  const loadAvailableDriverProfiles = async () => {
    if (!profile) return;
    const { data } = await getAvailableDriverProfiles(eventId, profile.fraternity_name);
    setAvailableDriverProfiles(data);
  };

  const handleAddDriver = async (profileId: string) => {
    await addDriverToEvent(eventId, profileId);
    await loadDrivers();
    await loadAvailableDriverProfiles();
  };

  const handleRemoveDriver = async (driverId: string) => {
    await removeDriverFromEvent(driverId);
    await loadDrivers();
    await loadAvailableDriverProfiles();
  };

  const handleAssignDriver = async (rideId: string, driverId: string) => {
    await assignDriverToRide(rideId, driverId);
    setSelectedRide(null);
    loadRides();
    loadDrivers();
  };

  const handleCancelRide = async (rideId: string) => {
    await transitionRideStatus(rideId, "cancelled");
    loadRides();
    loadAnalytics();
  };

  const handleNoShow = async (rideId: string, driverId?: string) => {
    await transitionRideStatus(rideId, "no_show", driverId);
    loadRides();
    loadDrivers();
    loadAnalytics();
  };

  const copyAccessCode = () => {
    if (event) {
      navigator.clipboard.writeText(event.access_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  const waitingRides = rides.filter((r) => r.status === "waiting");
  const activeRides = rides.filter((r) => ["assigned", "arrived", "in_progress"].includes(r.status));
  const completedRides = rides.filter((r) => r.status === "completed");
  const cancelledRides = rides.filter((r) => r.status === "cancelled" || r.status === "no_show");
  const availableDrivers = drivers.filter((d) => d.current_status === "available");

  return (
    <div className="min-h-screen bg-dark-950">
      {/* Header */}
      <header className="border-b border-dark-800 bg-dark-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push("/admin/dashboard")}
                className="p-2 hover:bg-dark-800 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <h1 className="font-bold">{event?.event_name}</h1>
                <div className="flex items-center gap-2">
                  <Badge variant={event?.is_active ? "available" : "offline"}>
                    {event?.is_active ? "Active" : "Inactive"}
                  </Badge>
                  <button
                    onClick={copyAccessCode}
                    className="flex items-center gap-1 text-xs text-dark-400 hover:text-dark-200 font-mono"
                  >
                    {event?.access_code}
                    <Copy className="h-3 w-3" />
                    {copied && <span className="text-green-400">Copied!</span>}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAnalytics(!showAnalytics)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  showAnalytics
                    ? "bg-primary-600 text-white"
                    : "bg-dark-800 text-dark-400 hover:bg-dark-700"
                }`}
              >
                <BarChart3 className="h-4 w-4" />
                Analytics
              </button>
              <button
                onClick={toggleBatchMode}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  batchMode
                    ? "bg-purple-600 text-white"
                    : "bg-dark-800 text-dark-400 hover:bg-dark-700"
                }`}
                title="Batch nearby pickups together"
              >
                <Layers className="h-4 w-4" />
                {batchMode ? "Batch ON" : "Batch"}
              </button>
              <button
                onClick={() => setAutoAssign(!autoAssign)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  autoAssign
                    ? "bg-green-600 text-white"
                    : "bg-dark-800 text-dark-400 hover:bg-dark-700"
                }`}
              >
                <Zap className={`h-4 w-4 ${isAutoAssigning ? "animate-pulse" : ""}`} />
                {autoAssign ? "Smart Dispatch ON" : "Smart Dispatch"}
              </button>
              <Button variant="ghost" size="sm" onClick={loadData}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Emergency Banner */}
        {emergencies.length > 0 && (
          <div className="mb-6 space-y-3">
            {emergencies.map((emergency) => (
              <div
                key={emergency.id}
                className="bg-red-500/20 border border-red-500/50 rounded-xl p-4 flex items-start gap-4"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/30 flex items-center justify-center">
                  <ShieldAlert className="h-5 w-5 text-red-400 animate-pulse" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-red-400">Emergency Alert</h3>
                    <span className="text-xs text-dark-400">
                      {new Date(emergency.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-sm text-dark-200">
                    Triggered by {emergency.triggered_by}: <strong>{emergency.triggered_by_name}</strong>
                  </p>
                  {emergency.latitude && emergency.longitude && (
                    <a
                      href={`https://www.google.com/maps?q=${emergency.latitude},${emergency.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary-400 hover:underline mt-1 inline-block"
                    >
                      View Location
                    </a>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleResolveEmergency(emergency.id)}
                >
                  Resolve
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-yellow-900/30 rounded-lg">
                <Clock className="h-5 w-5 text-yellow-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{waitingRides.length}</p>
                <p className="text-xs text-dark-400">Waiting</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-900/30 rounded-lg">
                <Car className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{activeRides.length}</p>
                <p className="text-xs text-dark-400">Active</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-900/30 rounded-lg">
                <CheckCircle className="h-5 w-5 text-green-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{completedRides.length}</p>
                <p className="text-xs text-dark-400">Completed</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary-900/30 rounded-lg">
                <Users className="h-5 w-5 text-primary-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{availableDrivers.length}</p>
                <p className="text-xs text-dark-400">Available Drivers</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Analytics Panel */}
        {showAnalytics && analytics && (
          <div className="mb-8">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-4">
              <Card className="p-4">
                <p className="text-xs text-dark-400 mb-1">Total Rides</p>
                <p className="text-xl font-bold">{analytics.total_rides}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-dark-400 mb-1">Completed</p>
                <p className="text-xl font-bold text-green-400">{analytics.completed_rides}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-dark-400 mb-1">Cancelled</p>
                <p className="text-xl font-bold text-red-400">{analytics.cancelled_rides}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-dark-400 mb-1">No Shows</p>
                <p className="text-xl font-bold text-orange-400">{analytics.no_show_rides}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-dark-400 mb-1">Avg Wait</p>
                <p className="text-xl font-bold">{analytics.avg_wait_time_minutes.toFixed(1)}m</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-dark-400 mb-1">Avg Duration</p>
                <p className="text-xl font-bold">{analytics.avg_ride_duration_minutes.toFixed(1)}m</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-dark-400 mb-1">People Driven</p>
                <p className="text-xl font-bold text-primary-400">{analytics.total_passengers_driven}</p>
              </Card>
            </div>
            {/* Batch Analytics */}
            {analytics.total_batches > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="p-4 border-purple-500/30">
                  <p className="text-xs text-dark-400 mb-1">Total Batches</p>
                  <p className="text-xl font-bold text-purple-400">{analytics.total_batches}</p>
                </Card>
                <Card className="p-4 border-purple-500/30">
                  <p className="text-xs text-dark-400 mb-1">Avg Passengers/Batch</p>
                  <p className="text-xl font-bold text-purple-400">
                    {analytics.avg_passengers_per_batch?.toFixed(1) || 0}
                  </p>
                </Card>
                <Card className="p-4 border-purple-500/30">
                  <p className="text-xs text-dark-400 mb-1">Avg Rides/Batch</p>
                  <p className="text-xl font-bold text-purple-400">
                    {analytics.avg_rides_per_batch?.toFixed(1) || 0}
                  </p>
                </Card>
                <Card className="p-4 border-purple-500/30">
                  <p className="text-xs text-dark-400 mb-1">Batch Efficiency</p>
                  <p className="text-xl font-bold text-purple-400">
                    {analytics.batch_efficiency?.toFixed(0) || 0}%
                  </p>
                </Card>
              </div>
            )}
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Ride Queue */}
          <div className="lg:col-span-2 space-y-4">
            <h2 className="text-lg font-semibold">Ride Queue</h2>

            {rides.filter((r) => !["completed", "cancelled", "no_show"].includes(r.status)).length === 0 ? (
              <Card className="text-center py-8">
                <Car className="h-8 w-8 text-dark-600 mx-auto mb-2" />
                <p className="text-dark-400">No active ride requests</p>
              </Card>
            ) : (
              <div className="space-y-3">
                {rides
                  .filter((r) => !["completed", "cancelled", "no_show"].includes(r.status))
                  .map((ride, index) => (
                    <Card key={ride.id} className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            {ride.status === "waiting" && (
                              <span className="text-xs text-dark-500">#{index + 1}</span>
                            )}
                            <span className="font-medium">{ride.rider_name}</span>
                            <RideStatusBadge status={ride.status} />
                          </div>
                          <div className="flex items-start gap-2 text-sm text-dark-400">
                            <MapPin className="h-4 w-4 shrink-0 mt-0.5" />
                            <span>{ride.pickup_address}</span>
                          </div>
                          <div className="flex items-center gap-4 mt-2 text-sm">
                            <span className="text-dark-500">
                              {ride.passenger_count} passenger{ride.passenger_count > 1 ? "s" : ""}
                            </span>
                            <span className="text-dark-600">
                              {new Date(ride.created_at).toLocaleTimeString()}
                            </span>
                          </div>
                          {ride.driver?.profile && (
                            <div className="mt-2 flex items-center gap-3">
                              <span className="text-sm text-primary-400">
                                Driver: {ride.driver.profile.full_name}
                              </span>
                              {ride.driver_eta_minutes && (
                                <span className="flex items-center gap-1 text-xs text-cyan-400">
                                  <Timer className="h-3 w-3" />
                                  ETA: {formatETA(ride.driver_eta_minutes)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {ride.status === "waiting" && (
                            <>
                              <Button
                                size="sm"
                                onClick={() => setSelectedRide(ride.id)}
                                disabled={availableDrivers.length === 0}
                              >
                                Assign
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleCancelRide(ride.id)}
                              >
                                <XCircle className="h-4 w-4 text-red-400" />
                              </Button>
                            </>
                          )}
                          {(ride.status === "assigned" || ride.status === "arrived") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleNoShow(ride.id, ride.assigned_driver_id)}
                              title="Mark as No Show"
                            >
                              <AlertTriangle className="h-4 w-4 text-orange-400" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}
              </div>
            )}
          </div>

          {/* Drivers Panel */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Drivers</h2>
              <Button
                size="sm"
                onClick={() => {
                  loadAvailableDriverProfiles();
                  setShowAddDriverModal(true);
                }}
              >
                <UserPlus className="h-4 w-4 mr-1" />
                Add Driver
              </Button>
            </div>

            {drivers.length === 0 ? (
              <Card className="text-center py-8">
                <Users className="h-8 w-8 text-dark-600 mx-auto mb-2" />
                <p className="text-dark-400 text-sm">No drivers assigned</p>
                <p className="text-dark-500 text-xs mt-1">
                  Click "Add Driver" to assign drivers from your fraternity
                </p>
              </Card>
            ) : (
              <div className="space-y-3">
                {drivers.map((driver) => (
                  <Card key={driver.id} className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">
                          {driver.profile?.full_name || "Unknown"}
                        </p>
                        <DriverStatusBadge status={driver.current_status} />
                      </div>
                      {driver.current_status === "offline" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRemoveDriver(driver.id)}
                          title="Remove from event"
                        >
                          <XCircle className="h-4 w-4 text-red-400" />
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Assign Driver Modal */}
      {selectedRide && (
        <AssignDriverModal
          drivers={availableDrivers}
          onAssign={(driverId) => handleAssignDriver(selectedRide, driverId)}
          onClose={() => setSelectedRide(null)}
        />
      )}

      {/* Add Driver Modal */}
      {showAddDriverModal && (
        <AddDriverModal
          availableProfiles={availableDriverProfiles}
          onAdd={handleAddDriver}
          onClose={() => setShowAddDriverModal(false)}
        />
      )}
    </div>
  );
}

function AssignDriverModal({
  drivers,
  onAssign,
  onClose,
}: {
  drivers: Driver[];
  onAssign: (driverId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-dark-900 rounded-xl border border-dark-800 max-w-sm w-full p-6">
        <h2 className="text-lg font-bold mb-4">Assign Driver</h2>

        {drivers.length === 0 ? (
          <p className="text-dark-400 text-center py-4">No available drivers</p>
        ) : (
          <div className="space-y-2">
            {drivers.map((driver) => (
              <button
                key={driver.id}
                onClick={() => onAssign(driver.id)}
                className="w-full p-3 rounded-lg border border-dark-700 hover:border-primary-500 hover:bg-dark-800 transition-colors text-left"
              >
                <p className="font-medium">{driver.profile?.full_name}</p>
              </button>
            ))}
          </div>
        )}

        <Button variant="secondary" onClick={onClose} className="w-full mt-4">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddDriverModal({
  availableProfiles,
  onAdd,
  onClose,
}: {
  availableProfiles: Profile[];
  onAdd: (profileId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-dark-900 rounded-xl border border-dark-800 max-w-sm w-full p-6">
        <h2 className="text-lg font-bold mb-4">Add Driver to Event</h2>

        {availableProfiles.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-dark-400">No available drivers to add</p>
            <p className="text-dark-500 text-sm mt-2">
              Drivers need to sign up first at /driver/login with the same fraternity name
            </p>
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {availableProfiles.map((driverProfile) => (
              <button
                key={driverProfile.id}
                onClick={() => {
                  onAdd(driverProfile.id);
                  onClose();
                }}
                className="w-full p-3 rounded-lg border border-dark-700 hover:border-primary-500 hover:bg-dark-800 transition-colors text-left"
              >
                <p className="font-medium">{driverProfile.full_name}</p>
                <p className="text-xs text-dark-500">{driverProfile.fraternity_name}</p>
              </button>
            ))}
          </div>
        )}

        <Button variant="secondary" onClick={onClose} className="w-full mt-4">
          Cancel
        </Button>
      </div>
    </div>
  );
}
