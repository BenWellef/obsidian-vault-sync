import { Notice, Plugin } from "obsidian";
import { GitHubClient } from "./github";
import { MARKER_FILE, migrateData, settingsAreComplete } from "./settings";
import { VaultSyncSettingTab } from "./settingsTab";
import { SyncEngine, errorText } from "./sync";
import { PluginData, SyncMode, SyncResult, VaultSyncSettings, resultChanges } from "./types";

/** Delay after layout is ready before the startup sync fires. */
const STARTUP_DELAY_MS = 2000;

export default class VaultSyncPlugin extends Plugin {
	data!: PluginData;
	/** Same object as data.settings, typed for the base class contract. */
	settings!: VaultSyncSettings;
	private statusEl: HTMLElement | null = null;
	private syncing = false;
	private intervalId: number | null = null;

	async onload(): Promise<void> {
		this.data = migrateData(await this.loadData());
		this.settings = this.data.settings;

		this.addSettingTab(new VaultSyncSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("vault-sync-status");
		this.statusEl.onClickEvent(() => void this.sync("sync"));
		this.showLastSync();

		this.addRibbonIcon("refresh-cw", "VaultSync: sync now", () => void this.sync("sync"));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.sync("sync"),
		});
		this.addCommand({
			id: "force-upload",
			name: "Force upload: local vault wins",
			callback: () => void this.sync("push"),
		});
		this.addCommand({
			id: "force-download",
			name: "Force download: remote repository wins",
			callback: () => void this.sync("pull"),
		});

		await this.ensureMarker();
		this.restartAutoSync();

		if (this.settings.autoSyncOnLoad) {
			// Waiting for layout keeps the startup sync off the critical path, and the
			// extra delay lets other plugins finish writing their own config first.
			this.app.workspace.onLayoutReady(() => {
				this.registerInterval(
					window.setTimeout(() => void this.sync("sync", true), STARTUP_DELAY_MS)
				);
			});
		}
	}

	onunload(): void {
		this.stopAutoSync();
	}

	/** Persist settings and sync state back to data.json. */
	async saveData(): Promise<void> {
		await super.saveData(this.data);
	}

	restartAutoSync(): void {
		this.stopAutoSync();
		if (!this.settings.autoSyncInterval) return;
		const minutes = Math.max(1, this.settings.autoSyncIntervalMinutes);
		this.intervalId = window.setInterval(
			() => void this.sync("sync", true),
			minutes * 60 * 1000
		);
		this.registerInterval(this.intervalId);
	}

	private stopAutoSync(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	private showLastSync(): void {
		const last = this.data.syncState.lastSync;
		this.setStatus(
			last ? `VaultSync ${new Date(last).toLocaleTimeString()}` : "VaultSync: never synced"
		);
	}

	/** Recreate the vault root marker if it is missing. Format kept from v1. */
	private async ensureMarker(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(MARKER_FILE))) {
				await adapter.write(
					MARKER_FILE,
					`# Vault Sync\nInitialisiert: ${new Date().toISOString()}\n`
				);
			}
		} catch (err) {
			console.error("VaultSync: could not write marker file", err);
		}
	}

	/**
	 * Run one sync. `silent` suppresses the notice when nothing happened, so the
	 * periodic run stays quiet until it has something to report.
	 */
	async sync(mode: SyncMode, silent = false): Promise<void> {
		if (this.syncing) {
			if (!silent) new Notice("VaultSync: a sync is already running.");
			return;
		}
		const problem = settingsAreComplete(this.settings);
		if (problem) {
			if (!silent) new Notice(`VaultSync: ${problem}`);
			return;
		}

		this.syncing = true;
		this.setStatus("VaultSync: starting...");
		try {
			const engine = new SyncEngine(
				this.app,
				this.data,
				new GitHubClient(this.settings),
				(message) => this.setStatus(`VaultSync: ${message}`)
			);
			const result = await engine.run(mode);
			this.showLastSync();
			if (!silent || resultChanges(result) > 0 || result.errors.length > 0) {
				new Notice(summarize(mode, result), 8000);
			}
		} catch (err) {
			this.setStatus("VaultSync: failed");
			new Notice(`VaultSync failed: ${errorText(err)}`, 10000);
		} finally {
			// Always persist: a run that died halfway still made real changes, and
			// losing that bookkeeping would make the next sync redo or undo them.
			await this.saveData();
			this.syncing = false;
		}
	}
}

function summarize(mode: SyncMode, r: SyncResult): string {
	const parts: string[] = [];
	if (r.uploaded.length) parts.push(`${r.uploaded.length} uploaded`);
	if (r.downloaded.length) parts.push(`${r.downloaded.length} downloaded`);
	if (r.deletedRemote.length) parts.push(`${r.deletedRemote.length} deleted on remote`);
	if (r.deletedLocal.length) parts.push(`${r.deletedLocal.length} deleted locally`);
	if (r.conflicts.length) parts.push(`${r.conflicts.length} conflicts`);
	if (r.errors.length) parts.push(`${r.errors.length} errors`);

	const label = mode === "sync" ? "sync" : mode === "push" ? "force upload" : "force download";
	let message = `VaultSync (${label}): ${
		parts.length ? parts.join(", ") : "already up to date"
	}.`;

	if (r.truncated) {
		message +=
			"\nThe repository listing was truncated, so deletions were skipped this run.";
	}
	if (r.conflicts.length) {
		message += "\nConflicting versions were kept as .conflict-remote / .conflict-local files.";
	}
	for (const err of r.errors.slice(0, 3)) {
		message += `\n${err.path}: ${err.message}`;
	}
	if (r.errors.length > 3) {
		message += `\n...and ${r.errors.length - 3} more.`;
	}
	return message;
}
