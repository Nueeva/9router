// DB Schema definition
export const SCHEMA_VERSION = 12;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
`;

export const TABLES = {
  settings: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
    indexes: [],
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      email: "TEXT",
      priority: "INTEGER DEFAULT 0",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      data: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)"],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      data: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      data: "TEXT",
    },
    indexes: [],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT NOT NULL UNIQUE",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      tokenLimit: "INTEGER DEFAULT 0",
      usedTokens: "INTEGER DEFAULT 0",
      resetInterval: "TEXT DEFAULT 'never'",
      lastResetAt: "TEXT",
      allowedModels: "TEXT DEFAULT '*'",
      rpmLimit: "INTEGER DEFAULT 0",
      tpmLimit: "INTEGER DEFAULT 0",
      ipWhitelist: "TEXT DEFAULT ''",
      expiresAt: "TEXT",
      systemPrompt: "TEXT DEFAULT ''",
      permissions: "TEXT DEFAULT ''",
      createdBy: "TEXT DEFAULT ''",
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      kind: "TEXT NOT NULL",
      models: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [],
  },
};
