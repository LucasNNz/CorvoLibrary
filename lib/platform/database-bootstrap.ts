export type DatabaseBootstrapState = {
  ready: boolean;
  provider: "TURSO";
  missing: string[];
  marketplaceUrl: string;
};

const TURSO_MARKETPLACE_URL = "https://vercel.com/marketplace/tursocloud";

export function getDatabaseBootstrapState(): DatabaseBootstrapState {
  const url = process.env.TURSO_DATABASE_URL?.trim() || "";
  const token = process.env.TURSO_AUTH_TOKEN?.trim() || "";
  const missing: string[] = [];
  if (!url) missing.push("TURSO_DATABASE_URL");
  if (!token) missing.push("TURSO_AUTH_TOKEN");
  return {
    ready: missing.length === 0,
    provider: "TURSO",
    missing,
    marketplaceUrl: TURSO_MARKETPLACE_URL,
  };
}

export function assertDatabaseBootstrapReady() {
  const state = getDatabaseBootstrapState();
  if (!state.ready) throw new Error(`DATABASE_BOOTSTRAP_REQUIRED:${state.missing.join(",")}`);
  return state;
}
