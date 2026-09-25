export * from "./auth";
export * from "./events";
export * from "./rides";
export * from "./drivers";
// Auto/batch dispatch lives in "rides-dispatch" (server-only) and is
// intentionally not re-exported from the browser-safe service barrel.
export {
  haversineDistance,
  findNearestDriver,
  transitionRideStatus,
  getOldestWaitingRide,
  isValidTransition,
  calculateEstimatedWaitTime,
  updateAllWaitEstimates,
} from "./dispatchService";
export * from "./etaService";
export * from "./analyticsService";
export * from "./consentService";
export * from "./safetyService";
export * from "./emergencyService";
export * from "./batchService";
