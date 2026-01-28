"use client";

import { cn } from "@/utils/cn";
import { RideBatchItem, RideRequest } from "@/types/database";
import { Button } from "@/components/ui/Button";
import { formatETA } from "@/lib/services/etaService";

interface BatchPickupListProps {
  items: Array<
    RideBatchItem & {
      ride_request?: RideRequest;
    }
  >;
  currentIndex?: number;
  onPickupComplete?: (itemId: string) => Promise<void>;
  onNavigate?: (lat: number, lng: number, address: string) => void;
  isLoading?: boolean;
  className?: string;
}

export function BatchPickupList({
  items,
  currentIndex = 0,
  onPickupComplete,
  onNavigate,
  isLoading,
  className,
}: BatchPickupListProps) {
  // Sort by pickup order
  const sortedItems = [...items].sort(
    (a, b) => a.pickup_order_index - b.pickup_order_index
  );

  const pendingPickups = sortedItems.filter((item) => !item.picked_up);
  const completedPickups = sortedItems.filter((item) => item.picked_up);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-dark-200">
          Pickup Route ({completedPickups.length}/{sortedItems.length})
        </h3>
        <div className="text-xs text-dark-500">
          {pendingPickups.length} stops remaining
        </div>
      </div>

      <div className="space-y-2">
        {sortedItems.map((item, index) => {
          const ride = item.ride_request;
          const isNext = !item.picked_up && index === currentIndex;
          const isPast = item.picked_up;
          const isFuture = !item.picked_up && index > currentIndex;

          return (
            <div
              key={item.id}
              className={cn(
                "rounded-lg border p-3 transition-all",
                isNext
                  ? "border-primary-500 bg-primary-500/10"
                  : isPast
                    ? "border-dark-800 bg-dark-900/50 opacity-60"
                    : "border-dark-800 bg-dark-900"
              )}
            >
              <div className="flex items-start gap-3">
                {/* Stop number indicator */}
                <div
                  className={cn(
                    "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold",
                    isNext
                      ? "bg-primary-500 text-white"
                      : isPast
                        ? "bg-green-500/20 text-green-500"
                        : "bg-dark-800 text-dark-400"
                  )}
                >
                  {isPast ? (
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    item.pickup_order_index + 1
                  )}
                </div>

                {/* Pickup info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "font-medium",
                        isNext ? "text-primary-400" : "text-dark-200"
                      )}
                    >
                      {ride?.rider_name || "Unknown Rider"}
                    </span>
                    {ride?.passenger_count && ride.passenger_count > 1 && (
                      <span className="text-xs bg-dark-700 text-dark-300 px-1.5 py-0.5 rounded">
                        +{ride.passenger_count - 1}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-dark-400 truncate">
                    {ride?.pickup_address || "Address unavailable"}
                  </p>
                  {!isPast && item.estimated_arrival_time && (
                    <p className="text-xs text-dark-500 mt-1">
                      ETA:{" "}
                      {new Date(item.estimated_arrival_time).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  )}
                  {isPast && item.picked_up_at && (
                    <p className="text-xs text-green-500 mt-1">
                      Picked up at{" "}
                      {new Date(item.picked_up_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  )}
                </div>

                {/* Actions */}
                {isNext && (
                  <div className="flex flex-col gap-2">
                    {onNavigate && ride && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          onNavigate(
                            ride.pickup_lat,
                            ride.pickup_lng,
                            ride.pickup_address
                          )
                        }
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                        </svg>
                      </Button>
                    )}
                    {onPickupComplete && (
                      <Button
                        size="sm"
                        variant="success"
                        onClick={() => onPickupComplete(item.id)}
                        isLoading={isLoading}
                      >
                        Done
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Simple batch position display for riders
interface BatchPositionProps {
  position: number;
  totalStops: number;
  estimatedArrival?: string | null;
  className?: string;
}

export function BatchPosition({
  position,
  totalStops,
  estimatedArrival,
  className,
}: BatchPositionProps) {
  return (
    <div
      className={cn(
        "bg-primary-500/10 border border-primary-500/30 rounded-lg p-3",
        className
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary-500/20 flex items-center justify-center">
          <span className="text-primary-400 font-bold">{position}</span>
        </div>
        <div>
          <div className="text-sm text-dark-200">
            You are stop <span className="font-semibold text-primary-400">{position}</span> of{" "}
            <span className="font-semibold">{totalStops}</span>
          </div>
          {estimatedArrival && (
            <div className="text-xs text-dark-400">
              Estimated arrival:{" "}
              {new Date(estimatedArrival).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
