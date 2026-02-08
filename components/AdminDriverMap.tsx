"use client";

import { useEffect, useRef, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { Driver } from "@/types/database";

interface AdminDriverMapProps {
  drivers: Driver[];
  className?: string;
}

export function AdminDriverMap({ drivers, className = "" }: AdminDriverMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());

  const driversWithLocation = drivers.filter(
    (d) => d.current_lat != null && d.current_lng != null
  );

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey || !mapRef.current) return;

    const loader = new Loader({
      apiKey,
      version: "weekly",
      libraries: ["places"],
    });

    loader.load().then(() => {
      const mapInstance = new google.maps.Map(mapRef.current!, {
        center: { lat: 40.7128, lng: -74.006 },
        zoom: 12,
        styles: [
          { elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
          { elementType: "labels.text.stroke", stylers: [{ color: "#1a1a2e" }] },
          { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
          {
            featureType: "road",
            elementType: "geometry",
            stylers: [{ color: "#38414e" }],
          },
          {
            featureType: "road",
            elementType: "geometry.stroke",
            stylers: [{ color: "#212a37" }],
          },
          {
            featureType: "water",
            elementType: "geometry",
            stylers: [{ color: "#17263c" }],
          },
        ],
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: true,
      });

      setMap(mapInstance);
    });
  }, []);

  // Update markers when drivers change
  useEffect(() => {
    if (!map) return;

    const statusColors: Record<string, string> = {
      available: "#10b981", // green
      assigned: "#3b82f6", // blue
      offline: "#6b7280",  // gray
    };

    const currentDriverIds = new Set(driversWithLocation.map((d) => d.id));

    // Remove markers for drivers no longer in list or without location
    markersRef.current.forEach((marker, id) => {
      if (!currentDriverIds.has(id)) {
        marker.setMap(null);
        markersRef.current.delete(id);
      }
    });

    // Add or update markers
    const bounds = new google.maps.LatLngBounds();
    let hasLocations = false;

    driversWithLocation.forEach((driver) => {
      const lat = driver.current_lat!;
      const lng = driver.current_lng!;
      const color = statusColors[driver.current_status] || "#6b7280";
      const name = driver.profile?.full_name || "Driver";

      let marker = markersRef.current.get(driver.id);
      if (!marker) {
        marker = new google.maps.Marker({
          position: { lat, lng },
          map,
          icon: {
            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 7,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
          },
          title: `${name} (${driver.current_status})`,
        });
        markersRef.current.set(driver.id, marker);
      } else {
        marker.setPosition({ lat, lng });
        marker.setIcon({
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 7,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        });
        marker.setTitle(`${name} (${driver.current_status})`);
      }

      bounds.extend({ lat, lng });
      hasLocations = true;
    });

    if (hasLocations) {
      map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    }
  }, [map, driversWithLocation]);

  return (
    <div className={`rounded-xl border border-dark-800 overflow-hidden relative ${className}`}>
      <div ref={mapRef} className="w-full h-64 sm:h-80" />
      {driversWithLocation.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-dark-900/80 rounded-xl">
          <div className="text-center p-4">
            <p className="text-dark-400 text-sm">No drivers with location yet</p>
            <p className="text-dark-500 text-xs mt-1">
              Drivers need to go online on their device to appear on the map
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
