// Background provider health prober — the proactive half of the circuit breaker.
//
// Mirrors Firefly's `-health-check-interval` upstream probing: every tick it
// samples a bounded number of connections per provider, classifies the outcome
// (see open-sse/services/providerHealth.js) and folds it into a registry the
// router/API can consult. 9Router already cools a key down AFTER a live request
// fails (accountFallback.js); this surfaces the same signal BEFORE the request
// is made.
//
// Fail-open everywhere: a tick error, a provider that fails to load, or a probe
// that throws never kills the interval and never marks a provider unusable.
//
// State lives in memory and resets on restart (a fresh process re-probes). The
// registry is exposed read-only through GET /api/providers/health.

import * as log from "../utils/logger.js";
import {
  DEFAULT_HEALTH_CONFIG,
  aggregateClasses,
  applyProbe,
  classifyProbe,
  emptyEntry,
  providerVerdict,
  selectDueProviders,
} from "open-sse/services/providerHealth.js";

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;
const INITIAL_DELAY_MS = 20 * 1000;
const DEFAULT_SAMPLE_PER_PROVIDER = 2;
const PROBE_CONCURRENCY = 8;

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;

/** provider -> entry. Module-scoped so the API route can read it without a DB. */
const registry = new Map();

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

function healthConfig() {
  return {
    errorStrikes: Number(process.env.BG_PROVIDER_HEALTH_ERROR_STRIKES) || DEFAULT_HEALTH_CONFIG.errorStrikes,
    authStrikes: Number(process.env.BG_PROVIDER_HEALTH_AUTH_STRIKES) || DEFAULT_HEALTH_CONFIG.authStrikes,
    authCooldownMs:
      Number(process.env.BG_PROVIDER_HEALTH_AUTH_COOLDOWN_MS) || DEFAULT_HEALTH_CONFIG.authCooldownMs,
    errorCooldownMs:
      Number(process.env.BG_PROVIDER_HEALTH_ERROR_COOLDOWN_MS) || DEFAULT_HEALTH_CONFIG.errorCooldownMs,
  };
}

/** Read-only snapshot of the registry, verdicts resolved at `nowMs`. */
export function getProviderHealthSummary(nowMs = Date.now()) {
  const cfg = healthConfig();
  const out = {};
  for (const [provider, entry] of registry.entries()) {
    out[provider] = { ...entry, verdict: providerVerdict(entry, { nowMs, config: cfg }) };
  }
  return out;
}

/** Reset the registry (tests / manual clear). */
export function clearProviderHealth() {
  registry.clear();
}

async function loadActiveConnections() {
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  return getProviderConnections({ isActive: true });
}

/** Probe one connection through the same path the admin "Test" button uses. */
async function probeConnection(id) {
  const { testSingleConnection } = await import("../../app/api/providers/[id]/test/testUtils.js");
  return testSingleConnection(id);
}

/**
 * Group active connections by provider and pick a bounded sample per provider.
 * @param {Array<object>} connections
 * @param {number} sample
 * @returns {Map<string, string[]>} provider -> sampled connection ids
 */
export function sampleByProvider(connections, sample = DEFAULT_SAMPLE_PER_PROVIDER) {
  const groups = new Map();
  for (const conn of connections || []) {
    if (!conn || !conn.provider || !conn.id) continue;
    if (!groups.has(conn.provider)) groups.set(conn.provider, []);
    groups.get(conn.provider).push(conn.id);
  }
  const picked = new Map();
  for (const [provider, ids] of groups.entries()) {
    // Deterministic head-sample: stable across ticks, no RNG in the hot path.
    picked.set(provider, ids.slice(0, Math.max(1, sample)));
  }
  return picked;
}

/** Run `fn` over `items` with bounded concurrency, never rejecting. */
async function mapLimited(items, limit, fn) {
  const out = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        out[i] = { error: err?.message ?? String(err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * One scheduler tick. Fail-open at top level and per provider.
 * @param {{ loadConnections?: Function, probe?: Function }} [deps]
 */
export async function runProviderHealthTick(deps = {}) {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const load = deps.loadConnections || loadActiveConnections;
    const probe = deps.probe || probeConnection;
    const nowMs = Date.now();
    const cfg = healthConfig();

    const connections = await load();
    const sampled = sampleByProvider(
      connections,
      Number(process.env.BG_PROVIDER_HEALTH_SAMPLE) || DEFAULT_SAMPLE_PER_PROVIDER
    );
    const due = selectDueProviders([...sampled.keys()], Object.fromEntries(registry), { nowMs, config: cfg });

    for (const provider of due) {
      const ids = sampled.get(provider) || [];
      const results = await mapLimited(ids, PROBE_CONCURRENCY, async (id) => {
        const res = await probe(id);
        return classifyProbe({
          ok: Boolean(res && res.valid),
          status: Number(res && res.status) || 0,
          errorText: (res && res.error) || "",
        });
      });
      const cls = aggregateClasses(results);
      const prev = registry.get(provider) || emptyEntry();
      const errorText = results.find((r) => r && r !== "ok") || "";
      const next = applyProbe(prev, cls, { nowMs: Date.now(), config: cfg, errorText });
      registry.set(provider, next);

      const verdict = providerVerdict(next, { nowMs: Date.now(), config: cfg });
      if (verdict === "open") {
        log.warn("BG_PROVIDER_HEALTH", "Provider breaker opened", {
          provider,
          class: cls,
          strikes: next.strikes,
          cooldownMs: Math.max(0, (next.cooldownUntil || 0) - Date.now()),
        });
      }
    }
  } catch (err) {
    log.warn("BG_PROVIDER_HEALTH", "Tick failed (swallowed)", {
      error: err?.message ?? String(err),
    });
  } finally {
    tickRunning = false;
  }
}

/**
 * Start the background interval. Safe to call multiple times (no-op if started).
 * @param {{ intervalMs?: number }} [opts]
 * @returns {boolean} true if started this call
 */
export function startBackgroundProviderHealth({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_BACKGROUND_PROVIDER_HEALTH)) return false;
  if (isNonServerRuntime()) return false;

  started = true;
  const period =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : Number(process.env.BG_PROVIDER_HEALTH_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const safeTick = () => {
    runProviderHealthTick().catch((err) => {
      log.warn("BG_PROVIDER_HEALTH", "Unhandled tick rejection (swallowed)", {
        error: err?.message ?? String(err),
      });
    });
  };

  initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();

  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();

  return true;
}

export function stopBackgroundProviderHealth() {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
