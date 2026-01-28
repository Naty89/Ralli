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
} from "lucide-react";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { Badge } from "@/components/ui";
import { getCurrentUser, signOut } from "@/lib/services/auth";
import { getAdminEvents, createEvent, toggleEventActive } from "@/lib/services/events";
import { Event, Profile } from "@/types/database";

export default function AdminDashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Car className="h-6 w-6 text-primary-500" />
              <div>
                <span className="font-bold">Ralli</span>
                <span className="text-dark-500 ml-2">Admin</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-dark-400">{profile?.full_name}</span>
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Events</h1>
            <p className="text-dark-400">{profile?.fraternity_name}</p>
          </div>
          <Button onClick={() => setShowCreateModal(true)}>
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
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-dark-400">
                      {new Date(event.start_time).toLocaleDateString()}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleEvent(event.id, event.is_active);
                      }}
                      className={`p-2 rounded-lg transition-colors ${
                        event.is_active
                          ? "bg-green-900/30 text-green-400 hover:bg-green-900/50"
                          : "bg-dark-800 text-dark-500 hover:bg-dark-700"
                      }`}
                    >
                      <Power className="h-4 w-4" />
                    </button>
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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    const { error } = await createEvent(
      {
        event_name: eventName,
        fraternity_name: fraternityName,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
      },
      userId
    );

    if (error) {
      setError(error.message);
      setIsLoading(false);
      return;
    }

    onCreated();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-dark-900 rounded-xl border border-dark-800 max-w-md w-full p-6">
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
