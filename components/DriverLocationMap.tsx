"use client";

import { useEffect, useRef, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";

interface DriverLocationMapProps {
  driverLat: number;
  driverLng: number;
  pickupLat: number;
  pickupLng: number;
  className?: string;
}

export function DriverLocationMap({
  driverLat,
  driverLng,
  pickupLat,
  pickupLng,
  className = "",
}: DriverLocationMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [driverMarker, setDriverMarker] = useState<google.maps.Marker | null>(null);

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
        center: { lat: pickupLat, lng: pickupLng },
        zoom: 14,
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
        disableDefaultUI: true,
        zoomControl: true,
      });

      // Pickup marker
      new google.maps.Marker({
        position: { lat: pickupLat, lng: pickupLng },
        map: mapInstance,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: "#10b981",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
        title: "Pickup Location",
      });

      // Driver marker
      const marker = new google.maps.Marker({
        position: { lat: driverLat, lng: driverLng },
        map: mapInstance,
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 6,
          fillColor: "#3b82f6",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
          rotation: 0,
        },
        title: "Driver",
      });

      setMap(mapInstance);
      setDriverMarker(marker);

      // Fit bounds to show both markers
      const bounds = new google.maps.LatLngBounds();
      bounds.extend({ lat: pickupLat, lng: pickupLng });
      bounds.extend({ lat: driverLat, lng: driverLng });
      mapInstance.fitBounds(bounds, 50);
    });
  }, [pickupLat, pickupLng]);

  // Update driver position
  useEffect(() => {
    if (driverMarker) {
      driverMarker.setPosition({ lat: driverLat, lng: driverLng });
    }
  }, [driverLat, driverLng, driverMarker]);

  return (
    <div
      ref={mapRef}
      className={`w-full h-48 rounded-lg bg-dark-800 ${className}`}
    />
  );
}
