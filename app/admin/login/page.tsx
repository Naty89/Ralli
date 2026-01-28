"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Car, Copy, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { Card } from "@/components/ui";
import { signIn, signUpAdmin } from "@/lib/services/auth";

export default function AdminLoginPage() {
  const router = useRouter();
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [showOrgCode, setShowOrgCode] = useState(false);
  const [organizationCode, setOrganizationCode] = useState("");
  const [copied, setCopied] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [fraternityName, setFraternityName] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      if (isSignUp) {
        const { error, organizationCode: orgCode } = await signUpAdmin(
          email,
          password,
          fullName,
          fraternityName
        );
        if (error) {
          setError(error.message);
          setIsLoading(false);
          return;
        }
        // Show the organization code to the admin
        if (orgCode) {
          setOrganizationCode(orgCode);
          setShowOrgCode(true);
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
      router.push("/admin/dashboard");
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const copyOrgCode = () => {
    navigator.clipboard.writeText(organizationCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Show organization code screen after successful signup
  if (showOrgCode) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-900/50 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="h-8 w-8 text-green-400" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Account Created!</h1>
          <p className="text-dark-400 mb-6">
            Share this code with your drivers so they can join your organization
          </p>

          <div className="bg-dark-800 rounded-lg p-4 mb-6">
            <p className="text-xs text-dark-400 mb-2">Your Organization Code</p>
            <div className="flex items-center justify-center gap-3">
              <span className="text-3xl font-mono font-bold tracking-widest text-primary-400">
                {organizationCode}
              </span>
              <button
                onClick={copyOrgCode}
                className="p-2 hover:bg-dark-700 rounded-lg transition-colors"
              >
                <Copy className="h-5 w-5 text-dark-400" />
              </button>
            </div>
            {copied && (
              <p className="text-green-400 text-sm mt-2">Copied to clipboard!</p>
            )}
          </div>

          <p className="text-sm text-dark-500 mb-6">
            Drivers will enter this code when signing up at /driver/login
          </p>

          <Button onClick={() => router.push("/admin/dashboard")} className="w-full">
            Continue to Dashboard
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 rounded-full bg-primary-900/50 flex items-center justify-center">
              <Car className="h-8 w-8 text-primary-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold">
            {isSignUp ? "Create Admin Account" : "Admin Login"}
          </h1>
          <p className="text-dark-400 mt-2">
            {isSignUp
              ? "Set up your fraternity's Ralli account"
              : "Sign in to manage your events"}
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
                label="Organization Name"
                type="text"
                value={fraternityName}
                onChange={(e) => setFraternityName(e.target.value)}
                placeholder="Alpha Beta Gamma"
                required
              />
            </>
          )}
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
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

          <Button type="submit" className="w-full" isLoading={isLoading}>
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
            className="text-sm text-primary-400 hover:text-primary-300"
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
