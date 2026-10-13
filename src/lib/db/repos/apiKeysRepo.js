import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { DEFAULT_PERMISSIONS } from "@/lib/auth/permissionPaths";
import { parseAllowedModels, matchesAllowedModels, buildAllowedModelsSql, applyModelChangesToAllowList } from "./allowedModels.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

export { parseAllowedModels, matchesAllowedModels, buildAllowedModelsSql };

export function parsePermissions(permStr) {
  if (!permStr) return { ...DEFAULT_PERMISSIONS };
  if (typeof permStr === "object") return permStr;
  try {
    return JSON.parse(permStr);
  } catch {
    return { ...DEFAULT_PERMISSIONS };
  }
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    tokenLimit: row.tokenLimit || 0,
    usedTokens: row.usedTokens || 0,
    resetInterval: row.resetInterval || "never",
    lastResetAt: row.lastResetAt || null,
    allowedModels: row.allowedModels || "*",
    rpmLimit: row.rpmLimit || 0,
    tpmLimit: row.tpmLimit || 0,
    ipWhitelist: row.ipWhitelist || "",
    expiresAt: row.expiresAt || null,
    systemPrompt: row.systemPrompt || "",
    permissions: parsePermissions(row.permissions),
    createdBy: row.createdBy || "",
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt DESC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const now = new Date().toISOString();
  const accessInput = options.access || KEY_ACCESS_UNRESTRICTED;
  const cols = keyAccessToColumns(accessInput);
  const apiKey = {
    id: uuidv4(),
    name: name ? name.trim() : null,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: now,
    tokenLimit: Number(options.tokenLimit) || 0,
    usedTokens: Number(options.usedTokens) || 0,
    resetInterval: options.resetInterval || "never",
    lastResetAt: options.lastResetAt || now,
    allowedModels: options.allowedModels || "*",
    rpmLimit: Number(options.rpmLimit) || 0,
    tpmLimit: Number(options.tpmLimit) || 0,
    ipWhitelist: options.ipWhitelist || "",
    expiresAt: options.expiresAt || null,
    systemPrompt: options.systemPrompt || "",
    permissions: typeof options.permissions === "object" ? options.permissions : parsePermissions(options.permissions),
    createdBy: options.createdBy || "",
    access: keyAccessFromColumns(cols.accessRestricted, cols.accessAllow),
  };
  const permStr = typeof options.permissions === "string" ? options.permissions : JSON.stringify(apiKey.permissions);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, tokenLimit, usedTokens, resetInterval, lastResetAt, allowedModels, rpmLimit, tpmLimit, ipWhitelist, expiresAt, systemPrompt, permissions, createdBy, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id,
      apiKey.key,
      apiKey.name,
      apiKey.machineId,
      1,
      apiKey.createdAt,
      apiKey.tokenLimit,
      apiKey.usedTokens,
      apiKey.resetInterval,
      apiKey.lastResetAt,
      apiKey.allowedModels,
      apiKey.rpmLimit,
      apiKey.tpmLimit,
      apiKey.ipWhitelist,
      apiKey.expiresAt,
      apiKey.systemPrompt,
      permStr,
      apiKey.createdBy,
      cols.accessRestricted,
      cols.accessAllow,
    ]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const permStr = typeof merged.permissions === "string" ? merged.permissions : JSON.stringify(merged.permissions || {});
    const cols = keyAccessToColumns(merged.access || KEY_ACCESS_UNRESTRICTED);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, tokenLimit = ?, usedTokens = ?, resetInterval = ?, lastResetAt = ?, allowedModels = ?, rpmLimit = ?, tpmLimit = ?, ipWhitelist = ?, expiresAt = ?, systemPrompt = ?, permissions = ?, createdBy = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        Number(merged.tokenLimit) || 0,
        Number(merged.usedTokens) || 0,
        merged.resetInterval || "never",
        merged.lastResetAt || null,
        merged.allowedModels || "*",
        Number(merged.rpmLimit) || 0,
        Number(merged.tpmLimit) || 0,
        merged.ipWhitelist || "",
        merged.expiresAt || null,
        merged.systemPrompt || "",
        permStr,
        merged.createdBy || "",
        cols.accessRestricted,
        cols.accessAllow,
        id,
      ]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ? AND isActive = 1`, [key]);
  return row ? rowToKey(row) : null;
}

export async function recordApiKeyUsageInWindow(apiKeyStr, tokens = 0) {
  if (!apiKeyStr) return;
  const db = await getAdapter();
  try {
    db.run(
      `UPDATE apiKeys SET usedTokens = usedTokens + ? WHERE key = ?`,
      [Number(tokens) || 0, apiKeyStr]
    );
  } catch (err) {
    console.error("Failed to record API key usage:", err);
  }
}
