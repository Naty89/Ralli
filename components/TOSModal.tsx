"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/utils/cn";

interface TOSModalProps {
  onAccept: () => void;
  onClose: () => void;
  isLoading?: boolean;
  eventName?: string;
}

export function TOSModal({ onAccept, onClose, isLoading, eventName }: TOSModalProps) {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-dark-900 border border-dark-800 rounded-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-xl font-semibold text-dark-100 mb-4">
            Terms of Service
          </h2>

          {eventName && (
            <p className="text-dark-400 text-sm mb-4">
              Before requesting a ride for {eventName}, please review and accept our terms.
            </p>
          )}

          <div className="bg-dark-950 border border-dark-800 rounded-lg p-4 mb-6 max-h-60 overflow-y-auto text-sm text-dark-300">
            <h3 className="font-medium text-dark-200 mb-2">Rider Agreement</h3>
            <p className="mb-3">
              By using this ride service, you agree to the following terms:
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>
                You will be ready at your pickup location when the driver arrives.
              </li>
              <li>
                If you are not present within 3 minutes of driver arrival, you may be marked as a no-show.
              </li>
              <li>
                Repeated no-shows may result in a temporary cooldown period before you can request another ride.
              </li>
              <li>
                You agree to treat drivers with respect and follow their reasonable instructions.
              </li>
              <li>
                This service is provided as-is for event transportation. The organizers are not responsible for any delays or issues.
              </li>
              <li>
                In case of emergency, use the emergency button to alert event organizers immediately.
              </li>
              <li>
                Your approximate location may be shared with drivers for pickup purposes.
              </li>
            </ul>
          </div>

          <label className="flex items-start gap-3 mb-6 cursor-pointer">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className={cn(
                "mt-0.5 h-5 w-5 rounded border-dark-600 bg-dark-800",
                "text-primary-600 focus:ring-primary-500 focus:ring-offset-dark-950"
              )}
            />
            <span className="text-sm text-dark-200">
              I have read and agree to the terms of service
            </span>
          </label>

          <div className="flex gap-3">
            <Button
              variant="secondary"
              onClick={onClose}
              className="flex-1"
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onAccept}
              className="flex-1"
              disabled={!agreed || isLoading}
              isLoading={isLoading}
            >
              Accept & Continue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
