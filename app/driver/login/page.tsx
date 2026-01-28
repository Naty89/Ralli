"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Car } from "lucide-react";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { signIn, signUpDriver } from "@/lib/services/auth";

export default function DriverLoginPage() {
  const router = useRouter();
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [organizationCode, setOrganizationCode] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      if (isSignUp) {
        const { error } = await signUpDriver(email, password, fullName, organizationCode);
        if (error) {
          setError(error.message);
          setIsLoading(false);
          return;
        }
      } else {
        const { error } = await signIn(email, password);
        if (error) {
          setError(error.message);
          setIsLoading(false);
          return;
        }
      }
      router.push("/driver/dashboard");
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 rounded-full bg-green-900/50 flex items-center justify-center">
              <Car className="h-8 w-8 text-green-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold">
            {isSignUp ? "Create Driver Account" : "Driver Login"}
          </h1>
          <p className="text-dark-400 mt-2">
            {isSignUp
              ? "Sign up as a sober driver"
              : "Sign in to view your assignments"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <>
              <Input
                label="Full Name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="John Smith"
                required
              />
              <Input
                label="Organization Code"
                type="text"
                value={organizationCode}
                onChange={(e) => setOrganizationCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                className="uppercase tracking-widest"
                required
              />
              <p className="text-xs text-dark-500 -mt-2">
                Get this code from your admin/event organizer
              </p>
            </>
          )}
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="driver@example.com"
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            error={error}
          />

          <Button type="submit" variant="success" className="w-full" isLoading={isLoading}>
            {isSignUp ? "Create Account" : "Sign In"}
          </Button>
        </form>

        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError("");
            }}
            className="text-sm text-green-400 hover:text-green-300"
          >
            {isSignUp
              ? "Already have an account? Sign in"
              : "Need an account? Sign up"}
          </button>
        </div>

        <div className="text-center">
          <a href="/" className="text-sm text-dark-500 hover:text-dark-300">
            ← Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
