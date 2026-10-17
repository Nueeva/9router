import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "promptInjections";

function rowToRule(row) {
  if (!row) return null;
  const val = parseJson(row.value, {});
  return {
    id: row.key,
    name: val.name || "Untitled Injection",
    description: val.description || "",
    enabled: val.enabled !== false,
    // "all" | "models" | "combos" | "custom"
    targetType: val.targetType || "models",
    targetCombos: Array.isArray(val.targetCombos) ? val.targetCombos : [],
    targetModels: Array.isArray(val.targetModels) ? val.targetModels : [],
    // Target API keys (empty = all keys or unauthenticated)
    targetKeys: Array.isArray(val.targetKeys) ? val.targetKeys : [],
    // Prompt keyword / regex match condition
    matchCondition: {
      type: val.matchCondition?.type || "always", // "always" | "contains" | "regex"
      pattern: typeof val.matchCondition?.pattern === "string" ? val.matchCondition.pattern : "",
      caseSensitive: !!val.matchCondition?.caseSensitive,
    },
    // "system_prepend" | "system_append" | "system_override" | "user_prepend" | "user_append"
    position: val.position || "system_prepend",
    content: typeof val.content === "string" ? val.content : "",
    priority: Number.isFinite(val.priority) ? val.priority : 10,
    createdAt: val.createdAt || new Date().toISOString(),
    updatedAt: val.updatedAt || new Date().toISOString(),
  };
}

export async function getPromptInjections() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const rules = rows
    .map(rowToRule)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  return rules;
}

export async function getPromptInjectionById(id) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT key, value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
  return rowToRule(row);
}

export async function createPromptInjection(data) {
  const db = await getAdapter();
  const id = data.id || randomUUID();
  const now = new Date().toISOString();
  const rule = {
    id,
    name: (data.name || "New Prompt Injection").trim(),
    description: (data.description || "").trim(),
    enabled: data.enabled !== false,
    targetType: data.targetType || "models",
    targetCombos: Array.isArray(data.targetCombos) ? data.targetCombos.map((s) => String(s).trim()).filter(Boolean) : [],
    targetModels: Array.isArray(data.targetModels) ? data.targetModels.map((s) => String(s).trim()).filter(Boolean) : [],
    targetKeys: Array.isArray(data.targetKeys) ? data.targetKeys.map((s) => String(s).trim()).filter(Boolean) : [],
    matchCondition: {
      type: data.matchCondition?.type || "always",
      pattern: typeof data.matchCondition?.pattern === "string" ? data.matchCondition.pattern.trim() : "",
      caseSensitive: !!data.matchCondition?.caseSensitive,
    },
    position: data.position || "system_prepend",
    content: typeof data.content === "string" ? data.content : "",
    priority: Number.isFinite(data.priority) ? Number(data.priority) : 10,
    createdAt: now,
    updatedAt: now,
  };

  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, id, stringifyJson(rule)]
  );
  return rule;
}

export async function updatePromptInjection(id, data) {
  if (!id) return null;
  const db = await getAdapter();
  const existing = await getPromptInjectionById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updated = {
    ...existing,
    ...data,
    id,
    targetCombos: Array.isArray(data.targetCombos)
      ? data.targetCombos.map((s) => String(s).trim()).filter(Boolean)
      : existing.targetCombos,
    targetModels: Array.isArray(data.targetModels)
      ? data.targetModels.map((s) => String(s).trim()).filter(Boolean)
      : existing.targetModels,
    targetKeys: Array.isArray(data.targetKeys)
      ? data.targetKeys.map((s) => String(s).trim()).filter(Boolean)
      : existing.targetKeys,
    matchCondition: data.matchCondition !== undefined ? {
      type: data.matchCondition?.type || "always",
      pattern: typeof data.matchCondition?.pattern === "string" ? data.matchCondition.pattern.trim() : "",
      caseSensitive: !!data.matchCondition?.caseSensitive,
    } : existing.matchCondition,
    updatedAt: now,
  };

  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, id, stringifyJson(updated)]
  );
  return updated;
}

export async function deletePromptInjection(id) {
  if (!id) return false;
  const db = await getAdapter();
  const res = db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
  return (res?.changes ?? 0) > 0;
}

export async function togglePromptInjection(id, enabled) {
  return await updatePromptInjection(id, { enabled });
}

export async function reorderPromptInjections(orderedIds) {
  if (!Array.isArray(orderedIds)) return false;
  const db = await getAdapter();
  db.transaction(() => {
    orderedIds.forEach((id, index) => {
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
      if (row) {
        const val = parseJson(row.value, {});
        val.priority = index + 1;
        val.updatedAt = new Date().toISOString();
        db.run(`UPDATE kv SET value = ? WHERE scope = ? AND key = ?`, [stringifyJson(val), SCOPE, id]);
      }
    });
  });
  return true;
}

/**
 * Extract user prompt text across different wire formats for keyword/regex checks
 */
export function extractUserText(body) {
  if (!body) return "";
  if (Array.isArray(body.messages)) {
    const userMsgs = body.messages.filter((m) => m && m.role === "user");
    return userMsgs
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
            .map((p) => p.text || "")
            .join(" ");
        }
        return "";
      })
      .join("\n");
  }
  if (Array.isArray(body.contents)) {
    return body.contents
      .filter((c) => c && c.role === "user")
      .flatMap((c) => (Array.isArray(c.parts) ? c.parts.map((p) => p?.text || "") : []))
      .join("\n");
  }
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.input)) {
    return body.input
      .filter((i) => i && (i.role === "user" || i.type === "message"))
      .map((i) => (typeof i.content === "string" ? i.content : ""))
      .join("\n");
  }
  return "";
}

/**
 * Match a target against pattern (exact or wildcard prefix/suffix)
 */
function matchesPattern(target, pattern) {
  if (!target || !pattern) return false;
  const t = String(target).trim().toLowerCase();
  const p = String(pattern).trim().toLowerCase();
  if (p === "*" || p === t) return true;
  if (p.endsWith("*") && p.startsWith("*")) {
    return t.includes(p.slice(1, -1));
  }
  if (p.endsWith("*")) {
    return t.startsWith(p.slice(0, -1));
  }
  if (p.startsWith("*")) {
    return t.endsWith(p.slice(1));
  }
  return false;
}

/**
 * Evaluate if a rule matches the current request context (async to check API keys if needed)
 */
export async function isRuleMatching(rule, { modelStr = "", comboName = "", provider = "", model = "", apiKey = "", userText = "" } = {}) {
  if (!rule || !rule.enabled) return false;
  if (!rule.content || !rule.content.trim()) return false;

  // 1. Target API Keys restriction check
  if (Array.isArray(rule.targetKeys) && rule.targetKeys.length > 0) {
    if (!apiKey) return false;
    let matchesKey = rule.targetKeys.includes(apiKey);
    if (!matchesKey) {
      try {
        const { getApiKeyByKey } = await import("./apiKeysRepo.js");
        const keyObj = await getApiKeyByKey(apiKey);
        if (keyObj && (rule.targetKeys.includes(keyObj.id) || rule.targetKeys.includes(keyObj.name) || rule.targetKeys.includes(keyObj.key))) {
          matchesKey = true;
        }
      } catch {}
    }
    if (!matchesKey) return false;
  }

  // 2. Keyword / Regex trigger condition check
  if (rule.matchCondition && rule.matchCondition.type && rule.matchCondition.type !== "always") {
    const text = userText || "";
    const pattern = (rule.matchCondition.pattern || "").trim();
    if (!pattern) return false;

    if (rule.matchCondition.type === "contains") {
      const keywords = pattern.split(",").map((k) => k.trim()).filter(Boolean);
      const isCase = !!rule.matchCondition.caseSensitive;
      const targetString = isCase ? text : text.toLowerCase();
      const hasMatch = keywords.some((kw) => targetString.includes(isCase ? kw : kw.toLowerCase()));
      if (!hasMatch) return false;
    } else if (rule.matchCondition.type === "regex") {
      try {
        const flags = rule.matchCondition.caseSensitive ? "" : "i";
        const re = new RegExp(pattern, flags);
        if (!re.test(text)) return false;
      } catch {
        return false;
      }
    }
  }

  // 3. Target Scope check (Combos / Models / Global / Custom)
  const targetType = rule.targetType || "models";

  if (targetType === "all") {
    return true;
  }

  const matchesCombo = () => {
    if (!rule.targetCombos || rule.targetCombos.length === 0) return false;
    const candidates = [comboName, modelStr].filter(Boolean);
    return rule.targetCombos.some((combo) => candidates.some((cand) => matchesPattern(cand, combo)));
  };

  const matchesModel = () => {
    if (!rule.targetModels || rule.targetModels.length === 0) return false;
    const fullModel = provider && model ? `${provider}/${model}` : "";
    const candidates = [modelStr, model, fullModel].filter(Boolean);
    return rule.targetModels.some((pat) => candidates.some((cand) => matchesPattern(cand, pat)));
  };

  if (targetType === "combos") {
    return matchesCombo();
  }

  if (targetType === "models") {
    return matchesModel();
  }

  if (targetType === "custom") {
    return matchesCombo() || matchesModel();
  }

  return false;
}

/**
 * Substitute variables in prompt content
 */
export function interpolateVariables(template, { modelStr = "", provider = "", model = "" } = {}) {
  if (typeof template !== "string") return "";
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const effectiveModel = modelStr || (provider && model ? `${provider}/${model}` : model || "");

  return template
    .replaceAll("{{model}}", effectiveModel)
    .replaceAll("{{provider}}", provider || "")
    .replaceAll("{{date}}", dateStr)
    .replaceAll("{{time}}", timeStr)
    .replaceAll("{{datetime}}", now.toISOString());
}

/**
 * Apply prompt injection rules to a request body.
 * Mutates body in place and returns applied rule info.
 */
export async function applyPromptInjectionsToBody(body, context = {}) {
  try {
    if (!body || typeof body !== "object") return { modified: false, injectedRules: [] };

    const rules = await getPromptInjections();
    if (!rules || rules.length === 0) return { modified: false, injectedRules: [] };

    // Array of applied rule IDs on this body to guarantee idempotency and JSON safety
    if (!Array.isArray(body._appliedPromptInjections)) {
      body._appliedPromptInjections = [];
    }

    const userText = context.userText !== undefined ? context.userText : extractUserText(body);
    const enrichedContext = { ...context, userText };

    const appliedRuleNames = [];

    for (const rule of rules) {
      if (body._appliedPromptInjections.includes(rule.id)) continue;
      const matches = await isRuleMatching(rule, enrichedContext);
      if (!matches) continue;

      const promptText = interpolateVariables(rule.content, enrichedContext).trim();
      if (!promptText) continue;

      executeInjection(body, rule.position, promptText);
      body._appliedPromptInjections.push(rule.id);
      appliedRuleNames.push(rule.name || rule.id);
    }

    return {
      modified: appliedRuleNames.length > 0,
      injectedRules: appliedRuleNames,
    };
  } catch (err) {
    // Fail-open: never break chat requests
    return { modified: false, injectedRules: [] };
  }
}

/**
 * Execute actual mutation on body based on position
 */
export function executeInjection(body, position, promptText) {
  if (!body || !promptText) return;

  const pos = position || "system_prepend";

  // 1. SYSTEM PREPEND
  if (pos === "system_prepend") {
    // Claude / Anthropic format (takes precedence when body.system is defined)
    if (typeof body.system === "string") {
      body.system = `${promptText}\n\n${body.system}`;
      return;
    }
    if (Array.isArray(body.system)) {
      body.system.unshift({ type: "text", text: promptText });
      return;
    }

    // OpenAI Responses / instructions
    if (typeof body.instructions === "string") {
      body.instructions = `${promptText}\n\n${body.instructions}`;
      return;
    }

    // Gemini system_instruction format
    if (body.system_instruction && Array.isArray(body.system_instruction.parts)) {
      body.system_instruction.parts.unshift({ text: promptText });
      return;
    }
    if (body.contents && !body.system_instruction) {
      body.system_instruction = { parts: [{ text: promptText }] };
      return;
    }

    // OpenAI Chat format
    if (Array.isArray(body.messages)) {
      const idx = body.messages.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
      if (idx >= 0) {
        const existing = body.messages[idx];
        if (typeof existing.content === "string") {
          existing.content = `${promptText}\n\n${existing.content}`;
        } else if (Array.isArray(existing.content)) {
          existing.content.unshift({ type: "text", text: promptText });
        }
      } else {
        body.messages.unshift({ role: "system", content: promptText });
      }
      return;
    }

    if (body.system === undefined && !Array.isArray(body.messages) && !body.contents) {
      body.system = promptText;
      return;
    }
  }

  // 2. SYSTEM APPEND
  if (pos === "system_append") {
    // Claude / Anthropic format
    if (typeof body.system === "string") {
      body.system = `${body.system}\n\n${promptText}`;
      return;
    }
    if (Array.isArray(body.system)) {
      body.system.push({ type: "text", text: promptText });
      return;
    }

    // OpenAI Responses
    if (typeof body.instructions === "string") {
      body.instructions = body.instructions ? `${body.instructions}\n\n${promptText}` : promptText;
      return;
    }

    // Gemini
    if (body.system_instruction && Array.isArray(body.system_instruction.parts)) {
      body.system_instruction.parts.push({ text: promptText });
      return;
    }
    if (body.contents && !body.system_instruction) {
      body.system_instruction = { parts: [{ text: promptText }] };
      return;
    }

    // OpenAI Chat messages
    if (Array.isArray(body.messages)) {
      const idx = body.messages.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
      if (idx >= 0) {
        const existing = body.messages[idx];
        if (typeof existing.content === "string") {
          existing.content = `${existing.content}\n\n${promptText}`;
        } else if (Array.isArray(existing.content)) {
          existing.content.push({ type: "text", text: promptText });
        }
      } else {
        body.messages.unshift({ role: "system", content: promptText });
      }
      return;
    }

    if (body.system === undefined && !Array.isArray(body.messages) && !body.contents) {
      body.system = promptText;
      return;
    }
  }

  // 3. SYSTEM OVERRIDE
  if (pos === "system_override") {
    // Claude format
    if (body.system !== undefined) {
      body.system = promptText;
      return;
    }

    // Responses format
    if (body.instructions !== undefined) {
      body.instructions = promptText;
      return;
    }

    // Gemini format
    if (body.contents) {
      body.system_instruction = { parts: [{ text: promptText }] };
      return;
    }

    // OpenAI Chat
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.filter((m) => m && m.role !== "system" && m.role !== "developer");
      body.messages.unshift({ role: "system", content: promptText });
      return;
    }

    body.system = promptText;
    return;
  }

  // 4. USER PREPEND
  if (pos === "user_prepend") {
    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === "user") {
          if (typeof m.content === "string") {
            m.content = `${promptText}\n\n${m.content}`;
          } else if (Array.isArray(m.content)) {
            m.content.unshift({ type: "text", text: promptText });
          }
          break;
        }
      }
      return;
    }

    if (Array.isArray(body.contents)) {
      for (let i = body.contents.length - 1; i >= 0; i--) {
        const turn = body.contents[i];
        if (turn && turn.role === "user" && Array.isArray(turn.parts)) {
          turn.parts.unshift({ text: promptText });
          break;
        }
      }
      return;
    }
  }

  // 5. USER APPEND
  if (pos === "user_append") {
    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === "user") {
          if (typeof m.content === "string") {
            m.content = `${m.content}\n\n${promptText}`;
          } else if (Array.isArray(m.content)) {
            m.content.push({ type: "text", text: promptText });
          }
          break;
        }
      }
      return;
    }

    if (Array.isArray(body.contents)) {
      for (let i = body.contents.length - 1; i >= 0; i--) {
        const turn = body.contents[i];
        if (turn && turn.role === "user" && Array.isArray(turn.parts)) {
          turn.parts.push({ text: promptText });
          break;
        }
      }
      return;
    }
  }
}
