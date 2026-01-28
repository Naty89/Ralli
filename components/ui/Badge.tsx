import { cn } from "@/utils/cn";
import { RideStatus, DriverStatus } from "@/types/database";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "waiting" | "assigned" | "arrived" | "in_progress" | "completed" | "cancelled" | "no_show" | "available" | "offline";
  className?: string;
}

export function Badge({ children, variant = "default", className }: BadgeProps) {
  const variants = {
    default: "bg-dark-700 text-dark-300 border border-dark-600",
    waiting: "bg-yellow-900/50 text-yellow-400 border border-yellow-700",
    assigned: "bg-blue-900/50 text-blue-400 border border-blue-700",
    arrived: "bg-cyan-900/50 text-cyan-400 border border-cyan-700",
    in_progress: "bg-purple-900/50 text-purple-400 border border-purple-700",
    completed: "bg-green-900/50 text-green-400 border border-green-700",
    cancelled: "bg-red-900/50 text-red-400 border border-red-700",
    no_show: "bg-orange-900/50 text-orange-400 border border-orange-700",
    available: "bg-green-900/50 text-green-400 border border-green-700",
    offline: "bg-dark-700 text-dark-400 border border-dark-600",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

// Helper component for ride status
export function RideStatusBadge({ status }: { status: RideStatus }) {
  const labels: Record<RideStatus, string> = {
    waiting: "Waiting",
    assigned: "Assigned",
    arrived: "Arrived",
    in_progress: "In Progress",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "No Show",
  };

  return <Badge variant={status}>{labels[status]}</Badge>;
}

// Helper component for driver status
export function DriverStatusBadge({ status }: { status: DriverStatus }) {
  const labels: Record<DriverStatus, string> = {
    offline: "Offline",
    available: "Available",
    assigned: "On Ride",
  };

  const variants: Record<DriverStatus, BadgeProps["variant"]> = {
    offline: "offline",
    available: "available",
    assigned: "assigned",
  };

  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}
