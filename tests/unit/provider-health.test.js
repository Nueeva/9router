import { describe, it, expect } from "vitest";
import {
  HEALTH_VERDICT,
  DEFAULT_HEALTH_CONFIG,
  aggregateClasses,
  applyProbe,
  classifyProbe,
  emptyEntry,
  isProviderOpen,
  providerVerdict,
  selectDueProviders,
} from "../../open-sse/services/providerHealth.js";

describe("providerHealth — classifyProbe", () => {
  it("returns ok when the probe succeeded", () => {
    expect(classifyProbe({ ok: true })).toBe("ok");
    expect(classifyProbe({ ok: true, status: 500 })).toBe("ok");
  });

  it("classifies rate limits as rate_limited", () => {
    expect(classifyProbe({ status: 429, errorText: "Too Many Requests" })).toBe("rate_limited");
    expect(classifyProbe({ status: 403, errorText: "insufficient_quota" })).toBe("rate_limited");
    expect(classifyProbe({ status: 429, errorText: "usage exceeds frequency limit" })).toBe("rate_limited");
  });

  it("classifies a quota 403 as rate_limited, not auth_dead", () => {
    // The 403 quota case is the one that bites: both markers match, rate must win.
    expect(classifyProbe({ status: 403, errorText: "insufficient_quota for this key" })).toBe("rate_limited");
  });

  it("classifies revoked credentials as auth_dead", () => {
    expect(classifyProbe({ status: 401, errorText: "Invalid API key" })).toBe("auth_dead");
    expect(classifyProbe({ status: 403, errorText: "Forbidden" })).toBe("auth_dead");
    expect(classifyProbe({ status: 400, errorText: "no credentials are serving this model" })).toBe("auth_dead");
  });

  it("classifies 5xx and transport failures as upstream_error", () => {
    expect(classifyProbe({ status: 502, errorText: "bad gateway" })).toBe("upstream_error");
    expect(classifyProbe({ status: 0, errorText: "fetch failed: ECONNRESET" })).toBe("upstream_error");
    expect(classifyProbe({ status: 504, errorText: "" })).toBe("upstream_error");
  });

  it("falls back to unknown for anything unrecognised", () => {
    expect(classifyProbe({ status: 400, errorText: "model not found" })).toBe("unknown");
    expect(classifyProbe({})).toBe("unknown");
  });
});

describe("providerHealth — applyProbe / providerVerdict", () => {
  it("starts healthy and stays healthy while probes pass", () => {
    let e = emptyEntry();
    e = applyProbe(e, "ok", { nowMs: 1000 });
    expect(providerVerdict(e, { nowMs: 1000 })).toBe(HEALTH_VERDICT.HEALTHY);
    expect(e.strikes).toBe(0);
  });

  it("opens the breaker immediately on auth_dead", () => {
    const e = applyProbe(emptyEntry(), "auth_dead", { nowMs: 1000 });
    expect(isProviderOpen(e, { nowMs: 1000 })).toBe(true);
    expect(e.cooldownUntil).toBe(1000 + DEFAULT_HEALTH_CONFIG.authCooldownMs);
  });

  it("opens the breaker only after errorStrikes upstream_error probes", () => {
    let e = emptyEntry();
    e = applyProbe(e, "upstream_error", { nowMs: 1000 });
    expect(isProviderOpen(e, { nowMs: 1000 })).toBe(false);
    e = applyProbe(e, "upstream_error", { nowMs: 2000 });
    expect(isProviderOpen(e, { nowMs: 2000 })).toBe(false);
    e = applyProbe(e, "upstream_error", { nowMs: 3000 });
    expect(isProviderOpen(e, { nowMs: 3000 })).toBe(true);
    expect(e.cooldownUntil).toBe(3000 + DEFAULT_HEALTH_CONFIG.errorCooldownMs);
  });

  it("never opens the breaker on rate_limited", () => {
    let e = emptyEntry();
    for (let i = 0; i < 10; i++) e = applyProbe(e, "rate_limited", { nowMs: 1000 + i });
    expect(isProviderOpen(e, { nowMs: 2000 })).toBe(false);
    expect(providerVerdict(e, { nowMs: 2000 })).toBe(HEALTH_VERDICT.DEGRADED);
  });

  it("clears the breaker once a probe passes again", () => {
    let e = applyProbe(emptyEntry(), "auth_dead", { nowMs: 1000 });
    expect(isProviderOpen(e, { nowMs: 1000 })).toBe(true);
    e = applyProbe(e, "ok", { nowMs: 2000 });
    expect(e.openedAt).toBe(0);
    expect(e.cooldownUntil).toBe(0);
    expect(providerVerdict(e, { nowMs: 2000 })).toBe(HEALTH_VERDICT.HEALTHY);
  });

  it("reports cooling_down (half-open) after the cooldown elapses without a success", () => {
    const e = applyProbe(emptyEntry(), "auth_dead", { nowMs: 1000 });
    const later = e.cooldownUntil + 1;
    expect(providerVerdict(e, { nowMs: later })).toBe(HEALTH_VERDICT.COOLING_DOWN);
    expect(isProviderOpen(e, { nowMs: later })).toBe(false);
  });

  it("honours a config override for the strike threshold", () => {
    const cfg = { errorStrikes: 1 };
    const e = applyProbe(emptyEntry(), "upstream_error", { nowMs: 1000, config: cfg });
    expect(isProviderOpen(e, { nowMs: 1000, config: cfg })).toBe(true);
  });
});

describe("providerHealth — selectDueProviders", () => {
  it("probes unknown providers and skips those inside cooldown", () => {
    const open = applyProbe(emptyEntry(), "auth_dead", { nowMs: 1000 });
    const registry = { dead: open };
    const due = selectDueProviders(["dead", "fresh"], registry, { nowMs: 1500 });
    expect(due).toEqual(["fresh"]);
  });

  it("re-probes an opened provider once its cooldown has elapsed", () => {
    const open = applyProbe(emptyEntry(), "auth_dead", { nowMs: 1000 });
    const registry = { dead: open };
    const due = selectDueProviders(["dead"], registry, { nowMs: open.cooldownUntil + 1 });
    expect(due).toEqual(["dead"]);
  });

  it("accepts {name} objects as well as bare strings", () => {
    expect(selectDueProviders([{ name: "a" }, "b"], {}, { nowMs: 0 })).toEqual(["a", "b"]);
  });
});

describe("providerHealth — aggregateClasses", () => {
  it("is ok only when every probe passed", () => {
    expect(aggregateClasses(["ok", "ok"])).toBe("ok");
  });

  it("is degraded when some probes pass", () => {
    expect(aggregateClasses(["ok", "auth_dead"])).toBe("degraded");
  });

  it("prefers auth_dead over the softer failure classes", () => {
    expect(aggregateClasses(["auth_dead", "rate_limited"])).toBe("auth_dead");
    expect(aggregateClasses(["upstream_error", "rate_limited"])).toBe("rate_limited");
  });

  it("is unknown for an empty batch", () => {
    expect(aggregateClasses([])).toBe("unknown");
    expect(aggregateClasses(undefined)).toBe("unknown");
  });
});
