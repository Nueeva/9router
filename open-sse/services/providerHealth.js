// Provider health registry — Firefly-style circuit breaker + KeyRing cooldown.
//
// Firefly keeps a per-upstream breaker and a per-key KeyRing so traffic stops
// being routed into a dead upstream before a user request pays the timeout.
// 9Router already reacts to failures on live traffic (open-sse/services/accountFallback.js
// cools a key down after a 429/401), but it has no PROACTIVE signal: a provider
// whose keys were all revoked keeps being selected until requests fail.
//
// This module is the pure, dependency-free half of that gap: a state machine
// that turns a stream of probe outcomes into a per-provider verdict plus a
// cooldown deadline. The scheduler that produces the probe outcomes lives in
// src/sse/services/backgroundProviderHealth.js. Everything here is pure so it
// can be unit-tested without a server, DB, or network.
//
// Classes
// -------
//   ok             -> probe succeeded
//   rate_limited   -> 429 / quota (TRANSIENT: never opens the breaker)
//   auth_dead      -> 401/403/invalid key (opens the breaker immediately)
//   upstream_error -> 5xx / timeout / refused (opens after `errorStrikes`)
//   unknown        -> unclassified (never opens the breaker)

/** Breaker verdicts returned by `providerVerdict`. */
export const HEALTH_VERDICT = {
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  COOLING_DOWN: "cooling_down",
  OPEN: "open",
};

export const DEFAULT_HEALTH_CONFIG = {
  // Consecutive upstream_error probes before the breaker opens.
  errorStrikes: 3,
  // Consecutive auth_dead probes before the breaker opens (1 = immediate).
  authStrikes: 1,
  // How long a provider stays out of rotation once its breaker opens.
  authCooldownMs: 30 * 60 * 1000,
  errorCooldownMs: 10 * 60 * 1000,
  // A rate-limited provider is never opened; it is only reported.
  rateLimitCooldownMs: 60 * 1000,
};

// Ordered most-specific first: a quota 403 must read as rate_limited, not auth_dead.
const RATE_MARKERS = [
  "429",
  "rate limit",
  "rate_limit",
  "quota",
  "too many requests",
  "frequency limit",
  "insufficient_quota",
  "usage exceeds",
  "freeusage",
];
const AUTH_MARKERS = [
  "invalid api key",
  "invalid_api_key",
  "unauthorized",
  "authentication",
  "no credentials",
  "forbidden",
  "permission",
  "not logged in",
  "token expired",
];
const ERROR_MARKERS = [
  "bad gateway",
  "unavailable",
  "timeout",
  "timed out",
  "connection refused",
  "econnrefused",
  "econnreset",
  "upstream request failed",
  "fetch failed",
];

function _text(status, errorText) {
  const err = errorText == null ? "" : String(errorText);
  return `${err} ${status == null ? "" : status}`.toLowerCase();
}

/**
 * Classify a single probe outcome.
 * @param {{ ok?: boolean, status?: number, errorText?: string }} probe
 * @returns {"ok"|"rate_limited"|"auth_dead"|"upstream_error"|"unknown"}
 */
export function classifyProbe({ ok = false, status = 0, errorText = "" } = {}) {
  if (ok) return "ok";
  const text = _text(status, errorText);
  if (RATE_MARKERS.some((m) => text.includes(m))) return "rate_limited";
  if (AUTH_MARKERS.some((m) => text.includes(m))) return "auth_dead";
  if (status >= 500 || ERROR_MARKERS.some((m) => text.includes(m))) return "upstream_error";
  return "unknown";
}

/** Fresh per-provider entry. */
export function emptyEntry() {
  return {
    class: "ok",
    strikes: 0,
    consecutiveOk: 0,
    openedAt: 0,
    cooldownUntil: 0,
    lastProbeAt: 0,
    lastError: "",
  };
}

/**
 * Fold one probe outcome into a provider entry. Pure: returns a new entry.
 *
 * @param {object} entry      previous entry (or `emptyEntry()`)
 * @param {string} cls        class from `classifyProbe`
 * @param {{ nowMs?: number, config?: object, errorText?: string }} [opts]
 * @returns {object} next entry
 */
export function applyProbe(entry, cls, { nowMs = Date.now(), config = {}, errorText = "" } = {}) {
  const cfg = { ...DEFAULT_HEALTH_CONFIG, ...config };
  const next = { ...emptyEntry(), ...(entry || {}) };
  next.class = cls;
  next.lastProbeAt = nowMs;
  next.lastError = String(errorText || "").slice(0, 300);

  if (cls === "ok") {
    next.strikes = 0;
    next.consecutiveOk = (next.consecutiveOk || 0) + 1;
    // A passing probe clears the breaker.
    next.openedAt = 0;
    next.cooldownUntil = 0;
    return next;
  }

  next.consecutiveOk = 0;

  if (cls === "auth_dead") {
    next.strikes = (next.strikes || 0) + 1;
    if (next.strikes >= cfg.authStrikes) {
      next.openedAt = next.openedAt || nowMs;
      next.cooldownUntil = nowMs + cfg.authCooldownMs;
    }
    return next;
  }

  if (cls === "upstream_error") {
    next.strikes = (next.strikes || 0) + 1;
    if (next.strikes >= cfg.errorStrikes) {
      next.openedAt = next.openedAt || nowMs;
      next.cooldownUntil = nowMs + cfg.errorCooldownMs;
    }
    return next;
  }

  // rate_limited / unknown never open the breaker.
  if (cls === "rate_limited") {
    next.cooldownUntil = nowMs + cfg.rateLimitCooldownMs;
  }
  return next;
}

/**
 * Derive the verdict for a provider entry.
 * @param {object} entry
 * @param {{ nowMs?: number, config?: object }} [opts]
 * @returns {string} one of HEALTH_VERDICT
 */
export function providerVerdict(entry, { nowMs = Date.now(), config = {} } = {}) {
  const cfg = { ...DEFAULT_HEALTH_CONFIG, ...config };
  const e = entry || emptyEntry();

  if (e.openedAt) {
    if (nowMs < (e.cooldownUntil || 0)) return HEALTH_VERDICT.OPEN;
    // Cooldown elapsed but no successful probe yet: allow a half-open retry.
    return HEALTH_VERDICT.COOLING_DOWN;
  }
  if (e.class === "ok" && (e.strikes || 0) === 0) return HEALTH_VERDICT.HEALTHY;
  if (e.class === "rate_limited") return HEALTH_VERDICT.DEGRADED;
  return HEALTH_VERDICT.DEGRADED;
}

/**
 * Should routing avoid this provider right now?
 * Fail-open by design: unknown providers are always routable.
 *
 * @param {object} entry
 * @param {{ nowMs?: number, config?: object }} [opts]
 * @returns {boolean}
 */
export function isProviderOpen(entry, opts = {}) {
  return providerVerdict(entry, opts) === HEALTH_VERDICT.OPEN;
}

/**
 * Pick the providers to probe on this tick: everything enabled, but a provider
 * whose breaker is open is only re-probed once its cooldown has elapsed.
 *
 * @param {Array<object>} providers        provider names (or {name} objects)
 * @param {Record<string, object>} registry current entries
 * @param {{ nowMs?: number, config?: object }} [opts]
 * @returns {string[]}
 */
export function selectDueProviders(providers, registry = {}, { nowMs = Date.now(), config = {} } = {}) {
  const cfg = { ...DEFAULT_HEALTH_CONFIG, ...config };
  const names = (providers || [])
    .map((p) => (typeof p === "string" ? p : p && p.name))
    .filter(Boolean);
  const due = [];
  for (const name of names) {
    const entry = registry[name];
    if (!entry || !entry.openedAt) {
      due.push(name);
      continue;
    }
    if (nowMs >= (entry.cooldownUntil || 0)) due.push(name);
  }
  return due;
}

/**
 * Aggregate a batch of probe classes for one provider into the class used for
 * the registry update (worst-of, but a single success keeps it out of auth_dead).
 *
 * @param {string[]} classes
 * @returns {string}
 */
export function aggregateClasses(classes) {
  const list = (classes || []).filter(Boolean);
  if (list.length === 0) return "unknown";
  if (list.every((c) => c === "ok")) return "ok";
  if (list.some((c) => c === "ok")) return "degraded";
  if (list.some((c) => c === "auth_dead")) return "auth_dead";
  if (list.some((c) => c === "rate_limited")) return "rate_limited";
  if (list.some((c) => c === "upstream_error")) return "upstream_error";
  return "unknown";
}
