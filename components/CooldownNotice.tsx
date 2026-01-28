"use client";

import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import { CooldownStatus } from "@/types/database";

interface CooldownNoticeProps {
  cooldownStatus: CooldownStatus;
  className?: string;
}

export function CooldownNotice({ cooldownStatus, className }: CooldownNoticeProps) {
  const [remainingMinutes, setRemainingMinutes] = useState(
    cooldownStatus.remaining_minutes || 0
  );

  useEffect(() => {
    if (!cooldownStatus.cooldown_until) return;

    const updateRemaining = () => {
      const end = new Date(cooldownStatus.cooldown_until!);
      const now = new Date();
      const remaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 60000));
      setRemainingMinutes(remaining);
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 30000); // Update every 30 seconds

    return () => clearInterval(interval);
  }, [cooldownStatus.cooldown_until]);

  if (!cooldownStatus.is_in_cooldown || remainingMinutes <= 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-yellow-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="font-medium text-yellow-500 mb-1">Temporary Cooldown</h3>
          <p className="text-sm text-dark-300">
            You&apos;ve been placed in a temporary cooldown due to recent no-shows.
            Please wait before requesting another ride.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <div className="text-2xl font-bold text-yellow-500 font-mono">
              {remainingMinutes}
            </div>
            <div className="text-sm text-dark-400">
              {remainingMinutes === 1 ? "minute" : "minutes"} remaining
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
