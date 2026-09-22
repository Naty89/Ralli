export * from "./auth";
export * from "./events";
export * from "./rides";
export * from "./drivers";
// Dispatch service has duplicate assignDriverToRide - import directly from dispatchService if needed
// dispatchService has duplicate assignDriverToRide - import directly from
// dispatchService if needed. Auto/batch dispatch lives in "rides-dispatch"
// (server-only) and is intentionally not re-exported here.
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
