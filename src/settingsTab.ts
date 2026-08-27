import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";
import { GitHubClient } from "./github";
import { errorText } from "./sync";
import { ConflictStrategy } from "./types";

const STRATEGY_LABELS: Record<ConflictStrategy, string> = {
	newer: "Keep the newer version",
	local: "Always keep the local version",
	remote: "Always keep the remote version",
	manual: "Keep both, resolve by hand",
};

export class VaultSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VaultSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("Repository").setHeading();

		new Setting(containerEl)
			.setName("Access token")
			.setDesc(
				"GitHub personal access token with read and write access to the repository contents. Stored in plain text in this plugin's data.json, which is never synced."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.setPlaceholder("github_pat_...")
					.setValue(s.token)
					.onChange(async (value) => {
						s.token = value.trim();
						await this.plugin.saveData();
					});
			});

		new Setting(containerEl)
			.setName("Owner")
			.setDesc("User or organization the repository belongs to.")
			.addText((text) =>
				text
					.setPlaceholder("username")
					.setValue(s.owner)
					.onChange(async (value) => {
						s.owner = value.trim();
						await this.plugin.saveData();
					})
			);

		new Setting(containerEl)
			.setName("Repository")
			.addText((text) =>
				text
					.setPlaceholder("my-vault")
					.setValue(s.repo)
					.onChange(async (value) => {
						s.repo = value.trim();
						await this.plugin.saveData();
					})
			);

		new Setting(containerEl)
			.setName("Branch")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(s.branch)
					.onChange(async (value) => {
						s.branch = value.trim() || "main";
						await this.plugin.saveData();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verifies that the token can reach the repository and the branch exists.")
			.addButton((btn) =>
				btn
					.setButtonText("Test")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Testing...");
						try {
							await new GitHubClient(s).checkAccess();
							new Notice(`VaultSync: reached ${s.owner}/${s.repo} on ${s.branch}.`);
						} catch (err) {
							new Notice(`VaultSync: ${errorText(err)}`, 10000);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText("Test");
						}
					})
			);

		new Setting(containerEl).setName("What gets synced").setHeading();

		new Setting(containerEl)
			.setName("Ignored paths")
			.setDesc(
				"One path per line, relative to the vault root. A folder covers everything beneath it."
			)
			.addTextArea((area) => {
				area.inputEl.rows = 6;
				area.inputEl.addClass("vault-sync-ignore-input");
				area.setPlaceholder("Subject/big-folder\nnotes/scratch.md")
					.setValue(s.ignorePaths.join("\n"))
					.onChange(async (value) => {
						s.ignorePaths = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line !== "");
						await this.plugin.saveData();
					});
			});

		new Setting(containerEl)
			.setName("Sync attachments")
			.setDesc("Images, PDFs and other binary files that are not audio or video.")
			.addToggle((toggle) =>
				toggle.setValue(s.syncBinary).onChange(async (value) => {
					s.syncBinary = value;
					await this.plugin.saveData();
				})
			);

		new Setting(containerEl)
			.setName("Sync video")
			.addToggle((toggle) =>
				toggle.setValue(s.syncVideos).onChange(async (value) => {
					s.syncVideos = value;
					await this.plugin.saveData();
				})
			);

		new Setting(containerEl)
			.setName("Sync audio")
			.addToggle((toggle) =>
				toggle.setValue(s.syncAudio).onChange(async (value) => {
					s.syncAudio = value;
					await this.plugin.saveData();
				})
			);

		new Setting(containerEl)
			.setName("Sync Obsidian config")
			.setDesc(
				"Includes the .obsidian folder, so plugin lists and settings travel between devices. Workspace layout, compiled plugin bundles and this plugin's own data.json are always excluded."
			)
			.addToggle((toggle) =>
				toggle.setValue(s.syncObsidianConfig).onChange(async (value) => {
					s.syncObsidianConfig = value;
					await this.plugin.saveData();
				})
			);

		new Setting(containerEl).setName("Conflicts").setHeading();

		new Setting(containerEl)
			.setName("When both sides changed")
			.setDesc(
				"The losing version is always kept alongside as name.conflict-remote.md or name.conflict-local.md, so nothing is lost."
			)
			.addDropdown((drop) => {
				for (const [value, label] of Object.entries(STRATEGY_LABELS)) {
					drop.addOption(value, label);
				}
				drop.setValue(s.conflictStrategy).onChange(async (value) => {
					s.conflictStrategy = value as ConflictStrategy;
					await this.plugin.saveData();
				});
			});

		new Setting(containerEl).setName("Automatic sync").setHeading();

		new Setting(containerEl)
			.setName("Sync on startup")
			.addToggle((toggle) =>
				toggle.setValue(s.autoSyncOnLoad).onChange(async (value) => {
					s.autoSyncOnLoad = value;
					await this.plugin.saveData();
				})
			);

		new Setting(containerEl)
			.setName("Sync periodically")
			.addToggle((toggle) =>
				toggle.setValue(s.autoSyncInterval).onChange(async (value) => {
					s.autoSyncInterval = value;
					await this.plugin.saveData();
					this.plugin.restartAutoSync();
					this.display();
				})
			);

		if (s.autoSyncInterval) {
			new Setting(containerEl)
				.setName("Interval")
				.setDesc(`Every ${s.autoSyncIntervalMinutes} minutes.`)
				.addSlider((slider) =>
					slider
						.setLimits(1, 120, 1)
						.setValue(s.autoSyncIntervalMinutes)
						.setDynamicTooltip()
						.onChange(async (value) => {
							s.autoSyncIntervalMinutes = value;
							await this.plugin.saveData();
							this.plugin.restartAutoSync();
						})
				);
		}

		new Setting(containerEl).setName("Sync state").setHeading();

		const tracked = Object.keys(this.plugin.data.syncState.files).length;
		const last = this.plugin.data.syncState.lastSync;
		new Setting(containerEl)
			.setName("Tracked files")
			.setDesc(
				`${tracked} files tracked. Last sync: ${
					last ? new Date(last).toLocaleString() : "never"
				}.`
			)
			.addButton((btn) =>
				btn
					.setButtonText("Reset state")
					.setWarning()
					.onClick(async () => {
						// Without a base every differing file counts as a conflict, so the
						// next sync keeps both sides instead of silently picking one.
						this.plugin.data.syncState = { files: {}, lastSync: 0 };
						await this.plugin.saveData();
						new Notice(
							"VaultSync: sync state cleared. The next sync treats every difference as a conflict and keeps both versions."
						);
						this.display();
					})
			);
	}
}
