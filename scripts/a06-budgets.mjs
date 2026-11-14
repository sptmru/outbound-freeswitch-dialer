// Executable A06 specification. Not wired to product config/admission.
export const resources = Object.freeze({
  queue: { limit: 40, max: 200, unit: "calls", scope: "queue", overload: "capacity_exceeded" },
  fsChannels: { limit: 80, min: 16, max: 200, unit: "channels", scope: "FS", overload: "reject_new_channel" },
  channels: { limit: 72, max: 184, unit: "channels", scope: "deployment", overload: "reject_new_leg" },
  preAdmission: { limit: 8, max: 16, unit: "channels", scope: "deployment", overload: "503_before_answer" },
  fsTrunk: { limit: 40, min: 2, max: 80, unit: "legs", scope: "FS", overload: "503_before_answer" },
  trunk: { limit: 32, max: 64, unit: "legs", scope: "deployment", overload: "capacity_exceeded" },
  forwarding: { limit: 4, max: 8, unit: "legs", scope: "deployment", overload: "flow_failure_continuation" },
  supervisor: { limit: 4, max: 8, unit: "legs", scope: "deployment", overload: "refuse_supervision" },
  transferOverlap: { limit: 4, max: 8, unit: "legs", scope: "deployment", overload: "preserve_source" },
  journalSlots: {
    limit: 4096,
    min: 64,
    max: 16384,
    unit: "records",
    scope: "FS spool",
    overload: "503_before_answer"
  },
  journalMiB: { limit: 64, min: 8, max: 256, unit: "MiB", scope: "FS spool", overload: "503_before_answer" },
  backlog: {
    limit: 64,
    min: 8,
    max: 256,
    unit: "operations",
    scope: "deployment",
    overload: "defer_or_reject_unstarted"
  }
});

export const budgets = Object.freeze({
  apiReplicas: 2,
  workerReplicas: 2,
  executorPerWorker: 4,
  criticalPerWorker: 1,
  admissionPool: 4,
  heartbeatPool: 1,
  eventPool: 2,
  recoveryPool: 1,
  pgMax: 100,
  pgReserved: 3,
  otherConnections: 10,
  minimumHeadroom: 20,
  acquireMs: 250,
  lockMs: 250,
  statementMs: 500,
  commandMs: 5000,
  recoveryMs: 30000,
  offerMs: 15000,
  queueMs: 60000,
  connectMs: 10000,
  transferMs: 20000,
  forwardMs: 20000,
  flowMs: 90000,
  playbackMs: 30000,
  retries: 2,
  retryInitialMs: 500,
  retryMaxMs: 2000,
  heartbeatMs: 5000,
  deskLeaseMs: 20000,
  captureMs: 750,
  journalHttpMs: 1000,
  admissionP95Ms: 100,
  admissionP99Ms: 250,
  offerP95Ms: 500,
  offerP99Ms: 1000,
  connectionP95Ms: 2000,
  connectionP99Ms: 5000,
  controlP95Ms: 100,
  controlP99Ms: 250
});

export function validateBudgets(b = budgets) {
  for (const key of Object.keys(budgets)) {
    const value = b[key];
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
  }
  const connections =
    b.apiReplicas * (b.admissionPool + b.heartbeatPool + b.eventPool + b.recoveryPool) +
    b.workerReplicas * b.executorPerWorker;
  if (connections + b.pgReserved + b.otherConnections + b.minimumHeadroom > b.pgMax)
    throw new Error("Aggregate database connection budget exceeded");
  if (
    b.criticalPerWorker >= b.executorPerWorker ||
    b.commandMs >= b.connectMs ||
    b.connectMs >= b.queueMs ||
    b.retryInitialMs > b.retryMaxMs ||
    b.deskLeaseMs < 3 * b.heartbeatMs ||
    b.captureMs > b.journalHttpMs
  )
    throw new Error("Inconsistent deadlines/reserves");
  return { connections, headroom: b.pgMax - connections - b.pgReserved - b.otherConnections };
}

export function validateResourceLimits(
  limits = Object.fromEntries(Object.entries(resources).map(([key, spec]) => [key, spec.limit]))
) {
  for (const [key, spec] of Object.entries(resources)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (spec.min ?? 1) || limits[key] > spec.max)
      throw new Error(`Invalid resource ${key}`);
  }
  if (
    limits.channels + limits.preAdmission > limits.fsChannels ||
    limits.trunk + limits.preAdmission > limits.fsTrunk
  )
    throw new Error("Pre-admission headroom exhausted");
  return limits;
}

// Counts include reserved, live and uncertain claims. A limit reduction never
// mutates existing claims. A requeue consumes its existing return permit, delta=0.
export function capacityDecision(claims) {
  for (const { used, delta, limit } of claims) {
    if (![used, delta, limit].every(Number.isSafeInteger) || used < 0 || delta < 0 || limit < 1)
      throw new Error("Invalid capacity claim");
  }
  return claims.every(({ used, delta, limit }) => delta === 0 || used + delta <= limit);
}

export function retryAt({ attempt, now, deadline, cleanupConfirmed, excluded, uncertain }) {
  if (
    !cleanupConfirmed ||
    excluded ||
    uncertain ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > budgets.retries
  )
    return null;
  const next = now + Math.min(budgets.retryInitialMs * 2 ** (attempt - 1), budgets.retryMaxMs);
  return next + budgets.connectMs <= deadline ? next : null;
}

export function percentile(values, p) {
  if (!values.length) throw new Error("Missing measurements");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
}
