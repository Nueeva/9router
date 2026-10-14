import { describe, expect, it } from "vitest";
import { WEB_COOKIE_PROVIDERS } from "@/app/api/models/test/ping";

describe("model probe budget", () => {
  it("treats every web-cookie provider as slow-probing", () => {
    for (const provider of ["gemini-web", "kimi-web", "deepseek-web", "xiaomi-mimo"]) {
      expect(WEB_COOKIE_PROVIDERS.has(provider)).toBe(true);
    }
  });

  it("keeps REST providers out of the slow set", () => {
    for (const provider of ["openai", "anthropic", "gemini", "opencode-zen"]) {
      expect(WEB_COOKIE_PROVIDERS.has(provider)).toBe(false);
    }
  });
});
