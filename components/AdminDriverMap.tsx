"use client";

import { useEffect, useRef, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { Driver } from "@/types/database";

interface AdminDriverMapProps {
  drivers: Driver[];
  className?: string;
}

const STATUS_COLORS: Record<string, string> = {
  available: "#10b981",
  assigned: "#3b82f6",
  offline: "#6b7280",
};

export function AdminDriverMap({ drivers, className = "" }: AdminDriverMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

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
      infoWindowRef.current = new google.maps.InfoWindow();
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
      const color = STATUS_COLORS[driver.current_status] || "#6b7280";
      const name = driver.profile?.full_name || "Driver";
      const status = driver.current_status;

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
          title: `${name} (${status}) - Click for details`,
        });
        marker.addListener("click", () => {
          if (infoWindowRef.current) {
            infoWindowRef.current.setContent(
              `<div style="padding:8px;min-width:140px;color:#1f2937;">
                <strong style="color:#111;">${name}</strong><br/>
                <span style="color:#6b7280;font-size:12px;text-transform:capitalize;">${status}</span>
              </div>`
            );
            infoWindowRef.current.open(map, marker!);
          }
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
        marker.setTitle(`${name} (${status})`);
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
      {/* Legend: identify drivers by name */}
      {driversWithLocation.length > 0 && (
        <div className="absolute bottom-2 left-2 right-2 flex flex-wrap gap-2 p-2 bg-dark-900/95 rounded-lg">
          {driversWithLocation.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
              style={{
                backgroundColor: `${STATUS_COLORS[d.current_status] || "#6b7280"}20`,
                borderLeft: `3px solid ${STATUS_COLORS[d.current_status] || "#6b7280"}`,
              }}
            >
              <span className="font-medium text-dark-100">
                {d.profile?.full_name || "Driver"}
              </span>
              <span className="text-dark-500 capitalize">({d.current_status})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
