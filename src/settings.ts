import { ConflictStrategy, PluginData, VaultSyncSettings } from "./types";

export const PLUGIN_ID = "ben-vault-sync";

/** Marker file in the vault root. Format kept identical to v1. */
export const MARKER_FILE = ".vault-sync";

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	token: "",
	owner: "",
	repo: "",
	branch: "main",
	ignorePaths: [],
	conflictStrategy: "newer",
	syncBinary: true,
	syncVideos: false,
	syncAudio: false,
	autoSyncOnLoad: true,
	autoSyncInterval: true,
	syncObsidianConfig: true,
	autoSyncIntervalMinutes: 5,
};

const STRATEGIES: ConflictStrategy[] = ["newer", "local", "remote", "manual"];

/**
 * Coerce whatever came back from loadData() into a valid PluginData.
 *
 * v1 wrote exactly this shape, so an existing data.json carries over untouched -
 * including syncState, which is what spares a full re-hash of the whole vault.
 */
export function migrateData(raw: unknown): PluginData {
	const obj = (raw ?? {}) as Record<string, unknown>;
	const rawSettings = (obj.settings ?? {}) as Record<string, unknown>;
	const rawState = (obj.syncState ?? {}) as Record<string, unknown>;

	const str = (k: keyof VaultSyncSettings, fallback: string): string => {
		const v = rawSettings[k];
		return typeof v === "string" ? v : fallback;
	};
	const bool = (k: keyof VaultSyncSettings, fallback: boolean): boolean => {
		const v = rawSettings[k];
		return typeof v === "boolean" ? v : fallback;
	};

	const strategyRaw = rawSettings.conflictStrategy;
	const conflictStrategy = STRATEGIES.includes(strategyRaw as ConflictStrategy)
		? (strategyRaw as ConflictStrategy)
		: DEFAULT_SETTINGS.conflictStrategy;

	const minutesRaw = rawSettings.autoSyncIntervalMinutes;
	const minutes =
		typeof minutesRaw === "number" && minutesRaw >= 1 && minutesRaw <= 1440
			? Math.floor(minutesRaw)
			: DEFAULT_SETTINGS.autoSyncIntervalMinutes;

	const ignoreRaw = rawSettings.ignorePaths;
	const ignorePaths = Array.isArray(ignoreRaw)
		? ignoreRaw.filter((p): p is string => typeof p === "string" && p.trim() !== "")
		: [];

	const files: PluginData["syncState"]["files"] = {};
	const rawFiles = rawState.files;
	if (rawFiles && typeof rawFiles === "object") {
		for (const [path, entry] of Object.entries(rawFiles as Record<string, unknown>)) {
			const e = entry as Record<string, unknown>;
			if (typeof e?.sha === "string" && typeof e?.mtime === "number") {
				files[path] = { sha: e.sha, mtime: e.mtime };
			}
		}
	}

	return {
		settings: {
			token: str("token", ""),
			owner: str("owner", ""),
			repo: str("repo", ""),
			branch: str("branch", DEFAULT_SETTINGS.branch) || DEFAULT_SETTINGS.branch,
			ignorePaths,
			conflictStrategy,
			syncBinary: bool("syncBinary", DEFAULT_SETTINGS.syncBinary),
			syncVideos: bool("syncVideos", DEFAULT_SETTINGS.syncVideos),
			syncAudio: bool("syncAudio", DEFAULT_SETTINGS.syncAudio),
			autoSyncOnLoad: bool("autoSyncOnLoad", DEFAULT_SETTINGS.autoSyncOnLoad),
			autoSyncInterval: bool("autoSyncInterval", DEFAULT_SETTINGS.autoSyncInterval),
			syncObsidianConfig: bool("syncObsidianConfig", DEFAULT_SETTINGS.syncObsidianConfig),
			autoSyncIntervalMinutes: minutes,
		},
		syncState: {
			files,
			lastSync: typeof rawState.lastSync === "number" ? rawState.lastSync : 0,
		},
	};
}

export function settingsAreComplete(s: VaultSyncSettings): string | null {
	if (!s.token) return "No access token set.";
	if (!s.owner) return "No repository owner set.";
	if (!s.repo) return "No repository name set.";
	if (!s.branch) return "No branch set.";
	return null;
}
