/** One tracked file: the git blob SHA we last agreed on, plus the local mtime at that moment. */
export interface FileState {
	sha: string;
	mtime: number;
}

/**
 * Persisted sync bookkeeping. `files` is the common ancestor for three-way merges:
 * comparing local and remote against it is what tells a genuine edit apart from a
 * deletion. Format is unchanged from v1 so existing state stays valid.
 */
export interface SyncState {
	files: Record<string, FileState>;
	lastSync: number;
}

export type ConflictStrategy = "newer" | "local" | "remote" | "manual";

export interface VaultSyncSettings {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	ignorePaths: string[];
	conflictStrategy: ConflictStrategy;
	syncBinary: boolean;
	syncVideos: boolean;
	syncAudio: boolean;
	autoSyncOnLoad: boolean;
	autoSyncInterval: boolean;
	syncObsidianConfig: boolean;
	/** Added in v2. v1 stored only the on/off flag and hardcoded the period. */
	autoSyncIntervalMinutes: number;
}

export interface PluginData {
	settings: VaultSyncSettings;
	syncState: SyncState;
}

export type SyncMode = "sync" | "push" | "pull";

export interface SyncResult {
	uploaded: string[];
	downloaded: string[];
	deletedRemote: string[];
	deletedLocal: string[];
	conflicts: string[];
	errors: { path: string; message: string }[];
	scannedLocal: number;
	scannedRemote: number;
	truncated: boolean;
}

export function emptyResult(): SyncResult {
	return {
		uploaded: [],
		downloaded: [],
		deletedRemote: [],
		deletedLocal: [],
		conflicts: [],
		errors: [],
		scannedLocal: 0,
		scannedRemote: 0,
		truncated: false,
	};
}

export function resultChanges(r: SyncResult): number {
	return (
		r.uploaded.length +
		r.downloaded.length +
		r.deletedRemote.length +
		r.deletedLocal.length +
		r.conflicts.length
	);
}
