import { readFileSync } from "node:fs";
import {
	conflictSidecar,
	isConflictSidecar,
	isIgnored,
	normalize,
	shouldSync,
} from "../src/paths";
import { gitBlobSha } from "../src/sha";
import { DEFAULT_SETTINGS, migrateData } from "../src/settings";
import { decide } from "../src/sync";
import { VaultSyncSettings } from "../src/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
	} else {
		failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
	}
}

function settings(over: Partial<VaultSyncSettings> = {}): VaultSyncSettings {
	return { ...DEFAULT_SETTINGS, ...over };
}

async function main(): Promise<void> {
	// --- git blob hashing, against values git itself produces -----------------
	const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
	check(
		"gitBlobSha: empty blob",
		await gitBlobSha(new ArrayBuffer(0)),
		"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
	);
	check(
		"gitBlobSha: hello",
		await gitBlobSha(enc("hello\n")),
		"ce013625030ba8dba906f756967f9e9ca394464a"
	);
	// Crosses the 64-byte SHA-1 block boundary and the padding edge case.
	check(
		"gitBlobSha: 1000 x a",
		await gitBlobSha(enc("a".repeat(1000))),
		"a50be72b20f0e3f078d252e8e56b11b4bec67509"
	);

	// --- path normalization ---------------------------------------------------
	check("normalize: backslashes", normalize("Informatik\\bluej\\x.md"), "Informatik/bluej/x.md");
	check("normalize: leading slash", normalize("/a/b"), "a/b");
	check("normalize: trailing slash", normalize("a/b/"), "a/b");
	check("normalize: dot prefix", normalize("./a"), "a");

	// --- ignore matching, using the exact v1 entries with mixed separators ----
	const v1Ignore = [
		"Seminarfach/greenfoot",
		"Informatik\\bluej",
		"Geschichte\\NS\\GeschichteV1.mov",
	];
	check("isIgnored: forward slash folder", isIgnored("Seminarfach/greenfoot/A.java", v1Ignore), true);
	check("isIgnored: backslash folder", isIgnored("Informatik/bluej/Foo.java", v1Ignore), true);
	check("isIgnored: backslash file", isIgnored("Geschichte/NS/GeschichteV1.mov", v1Ignore), true);
	check("isIgnored: folder itself", isIgnored("Seminarfach/greenfoot", v1Ignore), true);
	check("isIgnored: sibling not matched", isIgnored("Seminarfach/greenfoot2/A.java", v1Ignore), false);
	check("isIgnored: unrelated", isIgnored("Mathe/Analysis.md", v1Ignore), false);

	// --- shouldSync: the v1 bug is the config folder being unreachable --------
	const withConfig = settings({ syncObsidianConfig: true });
	const withoutConfig = settings({ syncObsidianConfig: false });
	check(
		"shouldSync: config included when enabled",
		shouldSync(".obsidian/community-plugins.json", withConfig, ".obsidian"),
		true
	);
	check(
		"shouldSync: config excluded when disabled",
		shouldSync(".obsidian/community-plugins.json", withoutConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: plugin manifest included",
		shouldSync(".obsidian/plugins/ben-vault-sync/manifest.json", withConfig, ".obsidian"),
		true
	);
	check(
		"shouldSync: own data.json never synced",
		shouldSync(".obsidian/plugins/ben-vault-sync/data.json", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: other plugin main.js excluded",
		shouldSync(".obsidian/plugins/omnisearch/main.js", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: workspace.json excluded",
		shouldSync(".obsidian/workspace.json", withConfig, ".obsidian"),
		false
	);
	// Security-critical: the local backup folder holds a copy of the access token.
	check(
		"shouldSync: backup folder never synced",
		shouldSync(".obsidian/plugins/.vault-sync-backup/data.json", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: backup notes never synced",
		shouldSync(".obsidian/plugins/.vault-sync-backup/RECONSTRUCTION.md", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: plugin data.json included",
		shouldSync(".obsidian/plugins/omnisearch/data.json", withConfig, ".obsidian"),
		true
	);
	check(
		"shouldSync: shipped plugin binary excluded",
		shouldSync(".obsidian/plugins/latex-math/bin/lmat-cas-client-win.bin", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: vendored plugin library excluded",
		shouldSync(".obsidian/plugins/doc-to-markdown/vendor-pdfjs.js", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: plugin styles excluded",
		shouldSync(".obsidian/plugins/ink/styles.css", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: theme kept",
		shouldSync(".obsidian/themes/Origami/theme.css", withConfig, ".obsidian"),
		true
	);
	check(
		"shouldSync: snippet kept",
		shouldSync(".obsidian/snippets/custom.css", withConfig, ".obsidian"),
		true
	);
	check(
		"shouldSync: nested vault config excluded",
		shouldSync("Spanisch/.obsidian/workspace.json", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: nested vault config excluded when config sync is off",
		shouldSync("Mathe/.obsidian/app.json", withoutConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: regenerable cache excluded",
		shouldSync(".smart-env/smart_sources/smart_sources.ajson", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: note named like a cache prefix still synced",
		shouldSync("smart-env-notes.md", withConfig, ".obsidian"),
		true
	);
	check("shouldSync: marker excluded", shouldSync(".vault-sync", withConfig, ".obsidian"), false);
	check("shouldSync: git excluded", shouldSync(".git/config", withConfig, ".obsidian"), false);
	check("shouldSync: trash excluded", shouldSync(".trash/old.md", withConfig, ".obsidian"), false);
	check("shouldSync: note included", shouldSync("Mathe/Analysis.md", withConfig, ".obsidian"), true);

	// --- sidecars never sync, so they can never cascade ----------------------
	check(
		"shouldSync: remote sidecar excluded",
		shouldSync("Hausaufgaben.conflict-remote.md", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: local sidecar excluded",
		shouldSync("Spanisch/SNN SNG.conflict-local.pdf", withConfig, ".obsidian"),
		false
	);
	check(
		"shouldSync: cascaded sidecar excluded",
		shouldSync("Hausaufgaben.conflict-remote.conflict-remote.md", withConfig, ".obsidian"),
		false
	);
	check("isConflictSidecar: plain note", isConflictSidecar("Hausaufgaben.md"), false);
	check("isConflictSidecar: remote copy", isConflictSidecar("Hausaufgaben.conflict-remote.md"), true);
	check("isConflictSidecar: no extension", isConflictSidecar("README.conflict-local"), true);
	check("isConflictSidecar: similar name", isConflictSidecar("conflict-remote-notes.md"), false);
	// A sidecar the engine produces must itself be excluded: that closes the loop.
	check(
		"a produced sidecar is never re-synced",
		shouldSync(conflictSidecar("Mathe/Analysis.md", "remote"), withConfig, ".obsidian"),
		false
	);

	// --- media gates ---------------------------------------------------------
	check("shouldSync: pdf follows syncBinary", shouldSync("a.pdf", settings({ syncBinary: true }), ".obsidian"), true);
	check("shouldSync: pdf off", shouldSync("a.pdf", settings({ syncBinary: false }), ".obsidian"), false);
	check("shouldSync: mov off by default", shouldSync("a.mov", settings(), ".obsidian"), false);
	check("shouldSync: mov on", shouldSync("a.mov", settings({ syncVideos: true }), ".obsidian"), true);
	check("shouldSync: mp3 off by default", shouldSync("a.mp3", settings(), ".obsidian"), false);
	check(
		"shouldSync: md not gated by syncBinary",
		shouldSync("a.md", settings({ syncBinary: false }), ".obsidian"),
		true
	);

	// --- conflict sidecar naming, matching what v1 left in the repository -----
	check(
		"conflictSidecar: matches v1 artefact",
		conflictSidecar("Hausaufgaben.md", "remote"),
		"Hausaufgaben.conflict-remote.md"
	);
	check(
		"conflictSidecar: nested path",
		conflictSidecar("Mathe/Analysis.md", "local"),
		"Mathe/Analysis.conflict-local.md"
	);
	check("conflictSidecar: no extension", conflictSidecar("README", "remote"), "README.conflict-remote");

	// --- the three-way decision table ---------------------------------------
	const L = (sha: string) => ({ sha, mtime: 1000, size: 1 });
	const R = (sha: string) => ({ sha, size: 1 });
	const B = (sha: string) => ({ sha, mtime: 1000 });

	check("decide: identical", decide(L("a"), R("a"), B("a")), "none");
	check("decide: identical without base", decide(L("a"), R("a"), undefined), "none");
	check("decide: local changed", decide(L("b"), R("a"), B("a")), "upload");
	check("decide: remote changed", decide(L("a"), R("b"), B("a")), "download");
	check("decide: both changed", decide(L("b"), R("c"), B("a")), "conflict");
	check("decide: both new, differing, no base", decide(L("b"), R("c"), undefined), "conflict");
	check("decide: new local file", decide(L("a"), undefined, undefined), "upload");
	check("decide: remote deleted, local untouched", decide(L("a"), undefined, B("a")), "deleteLocal");
	check("decide: remote deleted, local edited", decide(L("b"), undefined, B("a")), "upload");
	check("decide: new remote file", decide(undefined, R("a"), undefined), "download");
	check("decide: local deleted, remote untouched", decide(undefined, R("a"), B("a")), "deleteRemote");
	check("decide: local deleted, remote edited", decide(undefined, R("b"), B("a")), "download");
	check("decide: gone on both sides", decide(undefined, undefined, B("a")), "none");

	// --- migration of the v1 storage shape -----------------------------------
	// Inline fixture mirroring what v1 wrote, so the suite runs anywhere. The
	// "bad" entry must be dropped: a malformed sha would corrupt the base state.
	const v1 = {
		settings: {
			token: "github_pat_EXAMPLE",
			owner: "octocat",
			repo: "my-vault",
			branch: "main",
			ignorePaths: ["Subject/folder", "Other\\folder"],
			conflictStrategy: "newer",
			syncBinary: true,
			syncVideos: false,
			syncAudio: false,
			autoSyncOnLoad: true,
			autoSyncInterval: true,
			syncObsidianConfig: true,
		},
		syncState: {
			files: {
				"Mathe/Analysis.md": { sha: "aaa", mtime: 111 },
				"Sport/plan.pdf": { sha: "bbb", mtime: 222 },
				"broken.md": { sha: 5, mtime: 333 },
			},
			lastSync: 1787836654593,
		},
	};
	const migrated = migrateData(v1);
	check("migrate: owner", migrated.settings.owner, "octocat");
	check("migrate: repo", migrated.settings.repo, "my-vault");
	check("migrate: branch", migrated.settings.branch, "main");
	check("migrate: strategy", migrated.settings.conflictStrategy, "newer");
	check("migrate: token preserved", migrated.settings.token, "github_pat_EXAMPLE");
	check("migrate: ignorePaths preserved", migrated.settings.ignorePaths.length, 2);
	check("migrate: syncObsidianConfig preserved", migrated.settings.syncObsidianConfig, true);
	check("migrate: interval default added", migrated.settings.autoSyncIntervalMinutes, 5);
	check("migrate: malformed entry dropped", Object.keys(migrated.syncState.files).length, 2);
	check("migrate: lastSync preserved", migrated.syncState.lastSync, 1787836654593);
	check(
		"migrate: ignorePaths still match with either separator",
		[isIgnored("Subject/folder/x.md", migrated.settings.ignorePaths),
		 isIgnored("Other/folder/y.md", migrated.settings.ignorePaths)],
		[true, true]
	);

	// Optional: check a real v1 data.json when one is pointed at.
	const realData = process.env.V1_DATA;
	if (realData) {
		const raw = JSON.parse(readFileSync(realData, "utf8")) as {
			syncState: { files: Record<string, unknown> };
		};
		check(
			"migrate: real data.json keeps every tracked file",
			Object.keys(migrateData(raw).syncState.files).length,
			Object.keys(raw.syncState.files).length
		);
	}

	// --- migration robustness ------------------------------------------------
	const fresh = migrateData(undefined);
	check("migrate: empty input yields defaults", fresh.settings.branch, "main");
	check("migrate: empty input has no files", Object.keys(fresh.syncState.files).length, 0);
	const junk = migrateData({ settings: { branch: 42, conflictStrategy: "nonsense" }, syncState: 7 });
	check("migrate: bad branch falls back", junk.settings.branch, "main");
	check("migrate: bad strategy falls back", junk.settings.conflictStrategy, "newer");

	console.log(`${passed} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`  FAIL ${f}`);
	if (failures.length > 0) process.exit(1);
}

void main();
