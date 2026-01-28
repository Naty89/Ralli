"use client";

import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import { getRemainingDeadlineSeconds } from "@/lib/services/safetyService";

interface NoShowCountdownProps {
  arrivalDeadlineTimestamp: string;
  onExpired?: () => void;
  className?: string;
}

export function NoShowCountdown({
  arrivalDeadlineTimestamp,
  onExpired,
  className,
}: NoShowCountdownProps) {
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    getRemainingDeadlineSeconds(arrivalDeadlineTimestamp)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = getRemainingDeadlineSeconds(arrivalDeadlineTimestamp);
      setRemainingSeconds(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
        onExpired?.();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [arrivalDeadlineTimestamp, onExpired]);

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  const isUrgent = remainingSeconds <= 60;
  const isCritical = remainingSeconds <= 30;

  if (remainingSeconds <= 0) {
    return (
      <div className={cn("text-center", className)}>
        <div className="text-red-500 font-semibold">Time expired</div>
      </div>
    );
  }

  return (
    <div className={cn("text-center", className)}>
      <div className="text-sm text-dark-400 mb-1">
        Please confirm your presence
      </div>
      <div
        className={cn(
          "text-3xl font-bold font-mono",
          isCritical
            ? "text-red-500 animate-pulse"
            : isUrgent
              ? "text-yellow-500"
              : "text-dark-100"
        )}
      >
        {minutes}:{seconds.toString().padStart(2, "0")}
      </div>
      <div className="text-xs text-dark-500 mt-1">
        Tap &quot;I&apos;m Here&quot; when ready
      </div>

      {/* Progress ring */}
      <div className="mt-3 flex justify-center">
        <svg className="w-16 h-16 -rotate-90" viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="none"
            className="stroke-dark-800"
            strokeWidth="2"
          />
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="none"
            className={cn(
              "transition-all duration-1000",
              isCritical
                ? "stroke-red-500"
                : isUrgent
                  ? "stroke-yellow-500"
                  : "stroke-primary-500"
            )}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(remainingSeconds / 180) * 100.53} 100.53`}
          />
        </svg>
      </div>
    </div>
  );
}
