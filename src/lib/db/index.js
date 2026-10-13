// Public API barrel - all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

// Settings
export {
  getSettings, updateSettings, getSetting,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection, deleteProviderConnection,
} from "./repos/providerConnectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/providerNodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool, deleteProxyPools,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey, updateApiKey, deleteApiKey, validateApiKey, recordApiKeyUsageInWindow,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Request details & usage
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb(options = null) {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const isIncluded = (key) => {
    if (!options) return true;
    if (Array.isArray(options)) return options.length === 0 || options.includes(key);
    if (typeof options === "object") return options[key] !== false;
    return true;
  };

  const out = {};

  if (isIncluded("settings")) {
    out.settings = await exportSettings();
  }
  if (isIncluded("providers")) {
    out.providerConnections = db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    out.providerNodes = db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    out.proxyPools = db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  }
  if (isIncluded("apiKeys")) {
    out.apiKeys = db.all(`SELECT * FROM apiKeys`).map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      machineId: r.machineId,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
      tokenLimit: r.tokenLimit,
      usedTokens: r.usedTokens,
      resetInterval: r.resetInterval,
      lastResetAt: r.lastResetAt,
      allowedModels: r.allowedModels,
      rpmLimit: r.rpmLimit,
      tpmLimit: r.tpmLimit,
      ipWhitelist: r.ipWhitelist,
      expiresAt: r.expiresAt || null,
      systemPrompt: r.systemPrompt || "",
      permissions: r.permissions || "",
      createdBy: r.createdBy || "",
      access: keyAccessFromColumns(r.accessRestricted, r.accessAllow),
    }));
  }
  if (isIncluded("combos")) {
    out.combos = db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt }));
  }
  if (isIncluded("usage")) {
    out.usageHistory = db.all(`SELECT * FROM usageHistory ORDER BY id`);
    out.usageDaily = db.all(`SELECT * FROM usageDaily`);
  }
  if (isIncluded("customModels")) {
    out.modelAliases = {};
    out.customModels = [];
    out.mitmAlias = {};
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  }
  if (isIncluded("pricing")) {
    out.modelOverrides = {};
    out.pricing = {};
    out.disabledModels = {};
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelOverrides'`)) out.modelOverrides[r.key] = parseJson(r.value);
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'disabledModels'`)) out.disabledModels[r.key] = parseJson(r.value, []);
  }
  if (isIncluded("autoBackup")) {
    out.autoBackup = {};
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'autoBackup'`)) out.autoBackup[r.key] = parseJson(r.value);
  }

  return out;
}

export async function importDb(payload) {
  const db = await getAdapter();
  const existingApiKeys = {};
  for (const row of db.all(`SELECT * FROM apiKeys`)) {
    existingApiKeys[row.id] = row;
  }

  db.transaction(() => {
    if (payload.settings !== undefined) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    if (payload.providerConnections !== undefined) {
      db.run(`DELETE FROM providerConnections`);
      for (const c of payload.providerConnections || []) {
        const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
        db.run(
          `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.providerNodes !== undefined) {
      db.run(`DELETE FROM providerNodes`);
      for (const n of payload.providerNodes || []) {
        const { id, type, name, createdAt, updatedAt, ...rest } = n;
        db.run(
          `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.proxyPools !== undefined) {
      db.run(`DELETE FROM proxyPools`);
      for (const p of payload.proxyPools || []) {
        const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
        db.run(
          `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.apiKeys !== undefined) {
      db.run(`DELETE FROM apiKeys`);
      for (const k of payload.apiKeys || []) {
        const prev = existingApiKeys[k.id] || {};
        const tokenLimit = k.tokenLimit !== undefined ? Number(k.tokenLimit) : (prev.tokenLimit !== undefined ? Number(prev.tokenLimit) : 0);
        const usedTokens = k.usedTokens !== undefined ? Number(k.usedTokens) : (prev.usedTokens !== undefined ? Number(prev.usedTokens) : 0);
        const resetInterval = k.resetInterval !== undefined ? k.resetInterval : (prev.resetInterval || "never");
        const lastResetAt = k.lastResetAt !== undefined ? k.lastResetAt : (prev.lastResetAt || null);
        const allowedModels = k.allowedModels !== undefined ? k.allowedModels : (prev.allowedModels || "*");
        const rpmLimit = k.rpmLimit !== undefined ? Number(k.rpmLimit) : (prev.rpmLimit !== undefined ? Number(prev.rpmLimit) : 0);
        const tpmLimit = k.tpmLimit !== undefined ? Number(k.tpmLimit) : (prev.tpmLimit !== undefined ? Number(prev.tpmLimit) : 0);
        const ipWhitelist = k.ipWhitelist !== undefined ? k.ipWhitelist : (prev.ipWhitelist || "");
        const expiresAt = k.expiresAt !== undefined ? k.expiresAt : (prev.expiresAt || null);
        const systemPrompt = k.systemPrompt !== undefined ? k.systemPrompt : (prev.systemPrompt || "");
        const permissions = k.permissions !== undefined ? k.permissions : (prev.permissions || "");
        const createdBy = k.createdBy !== undefined ? k.createdBy : (prev.createdBy || "");

        let access = KEY_ACCESS_UNRESTRICTED;
        if (k.access !== undefined) {
          const checked = validateKeyAccessInput(k.access);
          if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
          access = checked.value;
        }
        const cols = keyAccessToColumns(access);

        db.run(
          `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, tokenLimit, usedTokens, resetInterval, lastResetAt, allowedModels, rpmLimit, tpmLimit, ipWhitelist, expiresAt, systemPrompt, permissions, createdBy, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            k.id,
            k.key,
            k.name || null,
            k.machineId || null,
            k.isActive === false ? 0 : 1,
            k.createdAt || new Date().toISOString(),
            tokenLimit,
            usedTokens,
            resetInterval,
            lastResetAt,
            allowedModels,
            rpmLimit,
            tpmLimit,
            ipWhitelist,
            expiresAt,
            systemPrompt,
            permissions,
            createdBy,
            cols.accessRestricted,
            cols.accessAllow,
          ]
        );
      }
    }

    if (payload.combos !== undefined) {
      db.run(`DELETE FROM combos`);
      for (const c of payload.combos || []) {
        db.run(
          `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.usageHistory !== undefined) {
      db.run(`DELETE FROM usageHistory`);
      for (const h of payload.usageHistory || []) {
        db.run(
          `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            h.timestamp || new Date().toISOString(),
            h.provider || null,
            h.model || null,
            h.connectionId || null,
            h.apiKey || null,
            h.endpoint || null,
            h.promptTokens || 0,
            h.completionTokens || 0,
            h.cost || 0,
            h.status || null,
            h.tokens || null,
            h.meta || null,
          ]
        );
      }
    }

    if (payload.usageDaily !== undefined) {
      db.run(`DELETE FROM usageDaily`);
      for (const d of payload.usageDaily || []) {
        db.run(
          `INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`,
          [d.dateKey, typeof d.data === "string" ? d.data : stringifyJson(d.data)]
        );
      }
    }

    if (payload.modelAliases !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'modelAliases'`);
      for (const [a, m] of Object.entries(payload.modelAliases || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
      }
    }

    if (payload.customModels !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'customModels'`);
      for (const m of payload.customModels || []) {
        const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
      }
    }

    if (payload.mitmAlias !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'mitmAlias'`);
      for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
      }
    }
    if (payload.pricing !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing'`);
      for (const [provider, models] of Object.entries(payload.pricing || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
      }
    }

    if (payload.modelOverrides !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'modelOverrides'`);
      for (const [k, v] of Object.entries(payload.modelOverrides || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelOverrides', ?, ?)`, [k, stringifyJson(v)]);
      }
    }

    if (payload.disabledModels !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'disabledModels'`);
      for (const [provider, ids] of Object.entries(payload.disabledModels || {})) {
        db.run(`INSERT INTO kv(scope, key, value) VALUES('disabledModels', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [provider, stringifyJson(ids || [])]);
      }
    }

    if (payload.autoBackup !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'autoBackup'`);
      for (const [key, value] of Object.entries(payload.autoBackup || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('autoBackup', ?, ?)`, [key, stringifyJson(value)]);
      }
    }
  });
}
