import { App, DataAdapter } from "obsidian";
import { GitHubClient, GitHubError, RemoteEntry } from "./github";
import { conflictSidecar, normalize, shouldSync } from "./paths";
import { gitBlobSha } from "./sha";
import {
	FileState,
	PluginData,
	SyncMode,
	SyncResult,
	VaultSyncSettings,
	emptyResult,
} from "./types";

/** Folders never worth descending into, regardless of settings. */
const PRUNED_FOLDERS = new Set([".git", ".trash", "node_modules", ".obsidian-git-data"]);

const DOWNLOAD_CONCURRENCY = 4;

interface LocalEntry {
	sha: string;
	mtime: number;
	size: number;
}

type Action =
	| { kind: "upload"; path: string; remoteSha?: string }
	| { kind: "download"; path: string; remoteSha: string }
	| { kind: "deleteLocal"; path: string }
	| { kind: "deleteRemote"; path: string; remoteSha: string }
	| { kind: "conflict"; path: string; remoteSha: string };

export type ProgressFn = (message: string) => void;

/**
 * Decide what to do with one path, given the local state, the remote state and
 * the base (what both sides last agreed on).
 *
 * The base is what separates an edit from a deletion: a file missing locally with
 * local == base means the user deleted it, whereas no base at all means it is new
 * on the remote side.
 */
export function decide(
	local: LocalEntry | undefined,
	remote: RemoteEntry | undefined,
	base: FileState | undefined
): Action["kind"] | "none" {
	if (local && remote) {
		if (local.sha === remote.sha) return "none";
		if (!base) return "conflict";
		if (local.sha === base.sha) return "download";
		if (remote.sha === base.sha) return "upload";
		return "conflict";
	}
	if (local && !remote) {
		// No base: new locally. Base matching local: the remote deleted it.
		// Otherwise the file changed locally after a remote delete, so local wins.
		if (base && local.sha === base.sha) return "deleteLocal";
		return "upload";
	}
	if (!local && remote) {
		if (base && remote.sha === base.sha) return "deleteRemote";
		return "download";
	}
	return "none";
}

export class SyncEngine {
	private adapter: DataAdapter;

	constructor(
		private app: App,
		private data: PluginData,
		private gh: GitHubClient,
		private progress: ProgressFn
	) {
		this.adapter = app.vault.adapter;
	}

	private get settings(): VaultSyncSettings {
		return this.data.settings;
	}

	/**
	 * Recursively list every file in the vault.
	 *
	 * Uses the raw adapter rather than vault.getFiles(), because the latter hides
	 * the config folder and dot files entirely. v1 skipped every dot folder while
	 * walking, which is why syncObsidianConfig never had any effect.
	 */
	private async listLocalPaths(): Promise<string[]> {
		const out: string[] = [];
		const configDir = normalize(this.app.vault.configDir);
		const walk = async (folder: string): Promise<void> => {
			const listing = await this.adapter.list(folder);
			for (const file of listing.files) out.push(normalize(file));
			for (const sub of listing.folders) {
				const path = normalize(sub);
				const name = path.slice(path.lastIndexOf("/") + 1);
				if (PRUNED_FOLDERS.has(name)) continue;
				// Skip the whole config tree when it is not being synced: it holds
				// thousands of files and walking it would dominate the scan.
				if (!this.settings.syncObsidianConfig && path === configDir) continue;
				await walk(path);
			}
		};
		await walk("");
		return out;
	}

	/** Hash a local file, reusing the stored SHA when the mtime is untouched. */
	private async readLocalEntry(path: string): Promise<LocalEntry | undefined> {
		const stat = await this.adapter.stat(path);
		if (!stat || stat.type !== "file") return undefined;

		const known = this.data.syncState.files[path];
		if (known && known.mtime === stat.mtime) {
			return { sha: known.sha, mtime: stat.mtime, size: stat.size };
		}
		const content = await this.adapter.readBinary(path);
		return { sha: await gitBlobSha(content), mtime: stat.mtime, size: stat.size };
	}

	private async ensureParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		const folder = path.slice(0, slash);
		if (!(await this.adapter.exists(folder))) {
			await this.adapter.mkdir(folder);
		}
	}

	private async writeLocal(path: string, content: ArrayBuffer): Promise<FileState> {
		await this.ensureParent(path);
		await this.adapter.writeBinary(path, content);
		const stat = await this.adapter.stat(path);
		return {
			sha: await gitBlobSha(content),
			mtime: stat?.mtime ?? Date.now(),
		};
	}

	/** Delete into the vault local trash so it stays recoverable. */
	private async removeLocal(path: string): Promise<void> {
		try {
			await this.adapter.trashLocal(path);
		} catch {
			await this.adapter.remove(path);
		}
	}

	async run(mode: SyncMode): Promise<SyncResult> {
		const result = emptyResult();
		const state = this.data.syncState;
		const configDir = this.app.vault.configDir;

		this.progress("Checking access...");
		await this.gh.checkAccess();

		this.progress("Listing remote files...");
		const { files: remoteAll, truncated } = await this.gh.listTree();
		result.truncated = truncated;

		const remote = new Map<string, RemoteEntry>();
		for (const [path, entry] of remoteAll) {
			if (shouldSync(path, this.settings, configDir)) remote.set(path, entry);
		}
		result.scannedRemote = remote.size;

		this.progress("Scanning vault...");
		const localPaths = (await this.listLocalPaths()).filter((p) =>
			shouldSync(p, this.settings, configDir)
		);
		const local = new Map<string, LocalEntry>();
		for (const path of localPaths) {
			const entry = await this.readLocalEntry(path);
			if (entry) local.set(path, entry);
		}
		result.scannedLocal = local.size;

		// A truncated tree means the remote listing is incomplete, so a missing
		// remote path cannot be trusted to mean "deleted".
		const deletionsSafe = !truncated;

		const actions: Action[] = [];
		const paths = new Set<string>([
			...local.keys(),
			...remote.keys(),
			...Object.keys(state.files),
		]);

		for (const path of paths) {
			const l = local.get(path);
			const r = remote.get(path);
			const base = state.files[path];

			// Drop state for paths that are now filtered out or gone on both sides.
			if (!l && !r) {
				delete state.files[path];
				continue;
			}

			if (mode === "push") {
				if (l && (!r || l.sha !== r.sha)) {
					actions.push({ kind: "upload", path, remoteSha: r?.sha });
				}
				continue;
			}
			if (mode === "pull") {
				if (r && (!l || l.sha !== r.sha)) {
					actions.push({ kind: "download", path, remoteSha: r.sha });
				}
				continue;
			}

			const kind = decide(l, r, base);
			switch (kind) {
				case "upload":
					actions.push({ kind, path, remoteSha: r?.sha });
					break;
				case "download":
					if (r) actions.push({ kind, path, remoteSha: r.sha });
					break;
				case "conflict":
					if (r) actions.push({ kind, path, remoteSha: r.sha });
					break;
				case "deleteLocal":
					if (deletionsSafe) actions.push({ kind, path });
					break;
				case "deleteRemote":
					if (r && deletionsSafe) actions.push({ kind, path, remoteSha: r.sha });
					break;
				default:
					// Already in sync: refresh the base so the mtime shortcut keeps working.
					if (l) state.files[path] = { sha: l.sha, mtime: l.mtime };
					break;
			}
		}

		if (actions.length === 0) {
			state.lastSync = Date.now();
			return result;
		}

		await this.applyLocalActions(actions, result);
		await this.applyRemoteActions(actions, local, result);

		state.lastSync = Date.now();
		return result;
	}

	/** Downloads and local deletions. Safe to run concurrently. */
	private async applyLocalActions(actions: Action[], result: SyncResult): Promise<void> {
		const state = this.data.syncState;
		const downloads = actions.filter(
			(a): a is Extract<Action, { kind: "download" }> => a.kind === "download"
		);

		let done = 0;
		const worker = async (queue: Extract<Action, { kind: "download" }>[]) => {
			for (const action of queue) {
				try {
					const content = await this.gh.getBlob(action.remoteSha);
					state.files[action.path] = await this.writeLocal(action.path, content);
					result.downloaded.push(action.path);
				} catch (err) {
					result.errors.push({ path: action.path, message: errorText(err) });
				}
				done++;
				this.progress(`Downloading ${done}/${downloads.length}...`);
			}
		};

		const lanes: Extract<Action, { kind: "download" }>[][] = Array.from(
			{ length: DOWNLOAD_CONCURRENCY },
			() => []
		);
		downloads.forEach((a, i) => lanes[i % DOWNLOAD_CONCURRENCY].push(a));
		await Promise.all(lanes.map(worker));

		for (const action of actions) {
			if (action.kind !== "deleteLocal") continue;
			try {
				await this.removeLocal(action.path);
				delete state.files[action.path];
				result.deletedLocal.push(action.path);
			} catch (err) {
				result.errors.push({ path: action.path, message: errorText(err) });
			}
		}
	}

	/**
	 * Uploads, remote deletions and conflicts. Strictly sequential: every one of
	 * these is a commit on the same branch, and parallel writes would collide.
	 */
	private async applyRemoteActions(
		actions: Action[],
		local: Map<string, LocalEntry>,
		result: SyncResult
	): Promise<void> {
		const state = this.data.syncState;
		const writes = actions.filter(
			(a) => a.kind === "upload" || a.kind === "deleteRemote" || a.kind === "conflict"
		);

		let done = 0;
		for (const action of writes) {
			done++;
			this.progress(`Uploading ${done}/${writes.length}...`);
			try {
				if (action.kind === "upload") {
					const entry = local.get(action.path);
					if (!entry) continue;
					const content = await this.adapter.readBinary(action.path);
					const newSha = await this.gh.putFile(
						action.path,
						content,
						action.remoteSha,
						`vault-sync: update ${action.path}`
					);
					state.files[action.path] = { sha: newSha, mtime: entry.mtime };
					result.uploaded.push(action.path);
				} else if (action.kind === "deleteRemote") {
					await this.gh.deleteFile(
						action.path,
						action.remoteSha,
						`vault-sync: delete ${action.path}`
					);
					delete state.files[action.path];
					result.deletedRemote.push(action.path);
				} else {
					await this.resolveConflict(action.path, action.remoteSha, local, result);
				}
			} catch (err) {
				result.errors.push({ path: action.path, message: errorText(err) });
			}
		}
	}

	/**
	 * Both sides changed. The losing version is always kept as a sidecar
	 * (`name.conflict-remote.md` / `name.conflict-local.md`), so a conflict never
	 * destroys content regardless of which side wins.
	 */
	private async resolveConflict(
		path: string,
		remoteSha: string,
		local: Map<string, LocalEntry>,
		result: SyncResult
	): Promise<void> {
		const state = this.data.syncState;
		const entry = local.get(path);
		if (!entry) return;

		const remoteData = await this.gh.getBlob(remoteSha);
		const localData = await this.adapter.readBinary(path);
		result.conflicts.push(path);

		if (this.settings.conflictStrategy === "manual") {
			// Park the remote version next to the local one and leave the file alone.
			// The base is deliberately not advanced, so this keeps being reported
			// until the two sides actually agree again.
			await this.writeLocal(conflictSidecar(path, "remote"), remoteData);
			return;
		}

		let localWins: boolean;
		if (this.settings.conflictStrategy === "local") {
			localWins = true;
		} else if (this.settings.conflictStrategy === "remote") {
			localWins = false;
		} else {
			const remoteTime = await this.gh.lastCommitTime(path);
			localWins = remoteTime === null || entry.mtime >= remoteTime;
		}

		if (localWins) {
			await this.writeLocal(conflictSidecar(path, "remote"), remoteData);
			const newSha = await this.gh.putFile(
				path,
				localData,
				remoteSha,
				`vault-sync: update ${path}`
			);
			state.files[path] = { sha: newSha, mtime: entry.mtime };
			result.uploaded.push(path);
		} else {
			await this.writeLocal(conflictSidecar(path, "local"), localData);
			state.files[path] = await this.writeLocal(path, remoteData);
			result.downloaded.push(path);
		}
	}
}

export function errorText(err: unknown): string {
	if (err instanceof GitHubError) return `${err.message} (HTTP ${err.status})`;
	if (err instanceof Error) return err.message;
	return String(err);
}
