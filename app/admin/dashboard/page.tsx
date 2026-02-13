"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Car,
  Plus,
  Calendar,
  Users,
  LogOut,
  Power,
  ChevronRight,
  Copy,
  CheckCircle,
  Share2,
  Edit2,
} from "lucide-react";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Badge } from "@/components/ui";
import { PlacesAutocomplete } from "@/components/PlacesAutocomplete";
import { getCurrentUser, signOut } from "@/lib/services/auth";
import { getAdminEvents, createEvent, toggleEventActive, updateEvent } from "@/lib/services/events";
import { Event, Profile } from "@/types/database";

export default function AdminDashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareLinkCopiedEventId, setShareLinkCopiedEventId] = useState<string | null>(null);

  const getEventShareLink = (accessCode: string) => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/rider?code=${encodeURIComponent(accessCode)}`;
  };

  const copyEventShareLink = (e: React.MouseEvent, accessCode: string, eventId: string) => {
    e.stopPropagation();
    const link = getEventShareLink(accessCode);
    navigator.clipboard.writeText(link);
    setShareLinkCopiedEventId(eventId);
    setTimeout(() => setShareLinkCopiedEventId(null), 2000);
  };

  const copyOrgCode = () => {
    if (profile?.organization_code) {
      navigator.clipboard.writeText(profile.organization_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const { user, profile, error } = await getCurrentUser();
    if (error || !profile || profile.role !== "admin") {
      router.push("/admin/login");
      return;
    }
    setProfile(profile);

    const { data: eventsData } = await getAdminEvents(profile.id);
    setEvents(eventsData);
    setIsLoading(false);
  };

  const handleSignOut = async () => {
    await signOut();
    router.push("/");
  };

  const handleToggleEvent = async (eventId: string, currentStatus: boolean) => {
    await toggleEventActive(eventId, !currentStatus);
    loadData();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-950">
      {/* Header */}
      <header className="border-b border-dark-800 bg-dark-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <Car className="h-6 w-6 text-primary-500 shrink-0" />
              <div className="min-w-0">
                <span className="font-bold">Ralli</span>
                <span className="text-dark-500 ml-1 sm:ml-2">Admin</span>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-4 shrink-0">
              <span className="text-xs sm:text-sm text-dark-400 truncate max-w-[100px] sm:max-w-none hidden sm:inline">
                {profile?.full_name}
              </span>
              <Button variant="ghost" size="sm" onClick={handleSignOut} className="min-h-[44px] min-w-[44px] p-0 flex items-center justify-center">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Organization Code Card */}
        <Card className="mb-6 sm:mb-8 bg-gradient-to-r from-primary-900/20 to-dark-900 border-primary-800/30">
          <div className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-dark-400 mb-1">Your Driver Code</p>
              <p className="text-xs text-dark-500">Share this with drivers to join your organization</p>
            </div>
            <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
              <span className="text-xl sm:text-2xl font-mono font-bold tracking-widest text-primary-400 break-all">
                {profile?.organization_code}
              </span>
              <button
                onClick={copyOrgCode}
                className="min-h-[44px] min-w-[44px] p-2 flex items-center justify-center hover:bg-dark-800 rounded-lg transition-colors shrink-0"
                title="Copy code"
              >
                {copied ? (
                  <CheckCircle className="h-5 w-5 text-green-400" />
                ) : (
                  <Copy className="h-5 w-5 text-dark-400" />
                )}
              </button>
            </div>
          </div>
        </Card>

        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 sm:mb-8">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold">Events</h1>
            <p className="text-sm text-dark-400">{profile?.fraternity_name}</p>
          </div>
          <Button onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto min-h-[44px]">
            <Plus className="h-4 w-4 mr-2" />
            Create Event
          </Button>
        </div>

        {/* Events Grid */}
        {events.length === 0 ? (
          <Card className="text-center py-12">
            <Calendar className="h-12 w-12 text-dark-600 mx-auto mb-4" />
            <h3 className="font-medium text-dark-300">No events yet</h3>
            <p className="text-dark-500 text-sm mt-1">
              Create your first event to get started
            </p>
            <Button onClick={() => setShowCreateModal(true)} className="mt-4">
              <Plus className="h-4 w-4 mr-2" />
              Create Event
            </Button>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {events.map((event) => (
              <Card
                key={event.id}
                className="hover:border-dark-700 transition-colors cursor-pointer"
                onClick={() => router.push(`/admin/event/${event.id}`)}
              >
                <CardHeader className="flex flex-row items-start justify-between">
                  <div>
                    <CardTitle>{event.event_name}</CardTitle>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant={event.is_active ? "available" : "offline"}>
                        {event.is_active ? "Active" : "Inactive"}
                      </Badge>
                      <span className="text-xs text-dark-500 font-mono">
                        {event.access_code}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-dark-600" />
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-sm gap-2">
                    <span className="text-dark-400">
                      {new Date(event.start_time).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => copyEventShareLink(e, event.access_code, event.id)}
                        className="min-h-[44px] min-w-[44px] p-2 flex items-center justify-center rounded-lg bg-dark-800 text-dark-400 hover:bg-dark-700 hover:text-primary-400 transition-colors active:scale-95"
                        title="Copy share link (send in a text)"
                      >
                        <Share2 className="h-4 w-4" />
                      </button>
                      {shareLinkCopiedEventId === event.id && (
                        <span className="text-xs text-green-400">Copied!</span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEvent(event);
                          setShowEditModal(true);
                        }}
                        className="min-h-[44px] min-w-[44px] p-2 flex items-center justify-center rounded-lg bg-dark-800 text-dark-400 hover:bg-dark-700 hover:text-primary-400 transition-colors active:scale-95"
                        title="Edit Event"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleEvent(event.id, event.is_active);
                        }}
                        className={`min-h-[44px] min-w-[44px] p-2 flex items-center justify-center rounded-lg transition-colors active:scale-95 ${
                          event.is_active
                            ? "bg-green-900/30 text-green-400 hover:bg-green-900/50"
                            : "bg-dark-800 text-dark-500 hover:bg-dark-700"
                        }`}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create Event Modal */}
      {showCreateModal && (
        <CreateEventModal
          fraternityName={profile?.fraternity_name || ""}
          userId={profile?.id || ""}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            loadData();
          }}
        />
      )}

      {/* Edit Event Modal */}
      {showEditModal && (
        <EditEventModal
          isOpen={showEditModal}
          onClose={() => {
            setShowEditModal(false);
            setSelectedEvent(null);
          }}
          event={selectedEvent}
          onSuccess={() => {
            loadData();
          }}
        />
      )}
    </div>
  );
}

function CreateEventModal({
  fraternityName,
  userId,
  onClose,
  onCreated,
}: {
  fraternityName: string;
  userId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [eventName, setEventName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [eventAddress, setEventAddress] = useState("");
  const [eventLat, setEventLat] = useState(0);
  const [eventLng, setEventLng] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    const input: any = {
      event_name: eventName,
      fraternity_name: fraternityName,
      start_time: new Date(startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
    };

    // Include event location if provided
    if (eventAddress && eventLat && eventLng) {
      input.event_address = eventAddress;
      input.event_lat = eventLat;
      input.event_lng = eventLng;
    }

    const { error } = await createEvent(input, userId);

    if (error) {
      setError(error.message);
      setIsLoading(false);
      return;
    }

    onCreated();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4 z-50 overflow-y-auto">
      <div className="bg-dark-900 rounded-t-2xl sm:rounded-xl border border-dark-800 max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold mb-4">Create New Event</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Event Name"
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            placeholder="Spring Formal 2024"
            required
          />
          <Input
            label="Start Time"
            type="datetime-local"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            required
          />
          <Input
            label="End Time"
            type="datetime-local"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            required
          />

          <div>
            <label className="block text-sm font-medium mb-2">
              Event Location (Optional)
            </label>
            <PlacesAutocomplete
              value={eventAddress}
              onChange={setEventAddress}
              onPlaceSelect={(place) => {
                setEventAddress(place.address);
                setEventLat(place.lat);
                setEventLng(place.lng);
              }}
              placeholder="Enter event address"
            />
            <p className="text-xs text-dark-500 mt-1">
              Adding an event location enables directional rides (to/from event)
            </p>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" isLoading={isLoading} className="flex-1">
              Create Event
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditEventModal({
  isOpen,
  onClose,
  event,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  event: Event | null;
  onSuccess: () => void;
}) {
  const [eventName, setEventName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [eventAddress, setEventAddress] = useState("");
  const [eventLat, setEventLat] = useState(0);
  const [eventLng, setEventLng] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // Pre-populate form when event changes
  useEffect(() => {
    if (event) {
      setEventName(event.event_name);
      // Convert ISO strings to datetime-local format (YYYY-MM-DDTHH:mm)
      setStartTime(event.start_time ? new Date(event.start_time).toISOString().slice(0, 16) : "");
      setEndTime(event.end_time ? new Date(event.end_time).toISOString().slice(0, 16) : "");
      setEventAddress(event.event_address || "");
      setEventLat(event.event_lat || 0);
      setEventLng(event.event_lng || 0);
    }
  }, [event]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!event) return;

    setError("");
    setIsLoading(true);

    // Validation
    if (!eventName.trim()) {
      setError("Event name is required");
      setIsLoading(false);
      return;
    }

    if (!startTime || !endTime) {
      setError("Start time and end time are required");
      setIsLoading(false);
      return;
    }

    // Ensure end time is after start time
    if (new Date(endTime) <= new Date(startTime)) {
      setError("End time must be after start time");
      setIsLoading(false);
      return;
    }

    // Build updates object
    const updates: any = {
      event_name: eventName.trim(),
      start_time: new Date(startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
    };

    // Include location if provided
    if (eventAddress && eventLat && eventLng) {
      updates.event_address = eventAddress;
      updates.event_lat = eventLat;
      updates.event_lng = eventLng;
    }

    const { error: updateError } = await updateEvent(event.id, updates);

    if (updateError) {
      setError(updateError.message);
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
    onSuccess();
    onClose();
  };

  if (!isOpen || !event) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-dark-900 rounded-t-2xl sm:rounded-xl border border-dark-800 max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold mb-4">Edit Event</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Event Name"
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            placeholder="e.g., Spring Formal"
            required
          />

          <Input
            label="Start Time"
            type="datetime-local"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            required
          />

          <Input
            label="End Time"
            type="datetime-local"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            required
          />

          <div>
            <label className="block text-sm font-medium mb-2">
              Event Location (Optional)
            </label>
            <PlacesAutocomplete
              value={eventAddress}
              onChange={setEventAddress}
              onPlaceSelect={(place) => {
                setEventAddress(place.address);
                setEventLat(place.lat);
                setEventLng(place.lng);
              }}
              placeholder="Enter event address"
            />
            <p className="text-xs text-dark-500 mt-1">
              Update location if needed for ride directions
            </p>
          </div>

          {error && (
            <div className="text-red-400 text-sm bg-red-900/20 p-3 rounded">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={isLoading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              isLoading={isLoading}
              className="flex-1"
            >
              Save Changes
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
