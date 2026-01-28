"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Car, Shield, Users } from "lucide-react";

export default function HomePage() {
  const router = useRouter();
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState("");

  const handleRiderAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessCode.trim()) {
      setError("Please enter an access code");
      return;
    }
    router.push(`/rider?code=${accessCode.toUpperCase()}`);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-dark-800 bg-dark-900/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Car className="h-8 w-8 text-primary-500" />
              <span className="text-xl font-bold">Ralli</span>
            </div>
            <nav className="flex items-center gap-4">
              <a
                href="/admin/login"
                className="text-sm text-dark-400 hover:text-dark-100 transition-colors"
              >
                Admin Login
              </a>
              <a
                href="/driver/login"
                className="text-sm text-dark-400 hover:text-dark-100 transition-colors"
              >
                Driver Login
              </a>
            </nav>
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <h1 className="text-4xl font-bold tracking-tight">
              Safe Rides Home
            </h1>
            <p className="mt-3 text-dark-400">
              Enter your event access code to request a ride
            </p>
          </div>

          <form onSubmit={handleRiderAccess} className="space-y-4">
            <div>
              <input
                type="text"
                value={accessCode}
                onChange={(e) => {
                  setAccessCode(e.target.value.toUpperCase());
                  setError("");
                }}
                placeholder="Enter access code (e.g., RALLY1)"
                className="input text-center text-lg tracking-widest uppercase"
                maxLength={6}
              />
              {error && (
                <p className="mt-2 text-sm text-red-400">{error}</p>
              )}
            </div>
            <button type="submit" className="btn btn-primary w-full py-3">
              Request a Ride
            </button>
          </form>

          {/* Features */}
          <div className="pt-8 grid grid-cols-3 gap-4 text-center">
            <div className="space-y-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary-900/50 flex items-center justify-center">
                <Shield className="h-6 w-6 text-primary-400" />
              </div>
              <p className="text-xs text-dark-400">Verified Drivers</p>
            </div>
            <div className="space-y-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary-900/50 flex items-center justify-center">
                <Car className="h-6 w-6 text-primary-400" />
              </div>
              <p className="text-xs text-dark-400">Real-time Tracking</p>
            </div>
            <div className="space-y-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary-900/50 flex items-center justify-center">
                <Users className="h-6 w-6 text-primary-400" />
              </div>
              <p className="text-xs text-dark-400">Event-based</p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-dark-800 py-4">
        <p className="text-center text-xs text-dark-500">
          Ralli - Event Transportation Management
        </p>
      </footer>
    </div>
  );
}
