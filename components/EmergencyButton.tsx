"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/utils/cn";

interface EmergencyButtonProps {
  onTrigger: () => Promise<void>;
  className?: string;
}

export function EmergencyButton({ onTrigger, className }: EmergencyButtonProps) {
  const [showModal, setShowModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [triggered, setTriggered] = useState(false);

  const handleConfirm = async () => {
    setIsLoading(true);
    try {
      await onTrigger();
      setTriggered(true);
      setShowModal(false);
    } catch (error) {
      console.error("Failed to trigger emergency:", error);
    } finally {
      setIsLoading(false);
    }
  };

  if (triggered) {
    return (
      <div
        className={cn(
          "fixed bottom-20 right-4 z-40 bg-red-600 text-white px-4 py-2 rounded-lg",
          "animate-pulse shadow-lg shadow-red-500/30",
          className
        )}
      >
        Emergency alert sent
      </div>
    );
  }

  return (
    <>
      {/* Floating emergency button */}
      <button
        onClick={() => setShowModal(true)}
        className={cn(
          "fixed bottom-20 right-4 z-40",
          "w-14 h-14 rounded-full bg-red-600 hover:bg-red-700",
          "flex items-center justify-center",
          "shadow-lg shadow-red-500/30 transition-all",
          "hover:scale-110 active:scale-95",
          className
        )}
        aria-label="Emergency"
      >
        <svg
          className="w-7 h-7 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </button>

      {/* Confirmation modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-dark-800 rounded-xl max-w-sm w-full p-6">
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20">
              <svg
                className="w-8 h-8 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>

            <h2 className="text-xl font-semibold text-dark-100 text-center mb-2">
              Trigger Emergency Alert?
            </h2>

            <p className="text-dark-400 text-sm text-center mb-6">
              This will immediately notify event organizers of your situation and location.
              Only use in genuine emergencies.
            </p>

            <div className="flex gap-3">
              <Button
                variant="secondary"
                onClick={() => setShowModal(false)}
                className="flex-1"
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleConfirm}
                className="flex-1"
                isLoading={isLoading}
              >
                Send Alert
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
