/**
 * Dry run for the local side of a first sync.
 *
 * Walks the real vault with the real shouldSync rules and the real settings, and
 * reports which files are not yet in the sync state, i.e. what the next sync
 * would upload. Does not touch the network and writes nothing.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shouldSync } from "../src/paths";
import { migrateData } from "../src/settings";

const VAULT = process.argv[2] ?? process.env.VAULT;
if (!VAULT) {
	console.error("usage: npm run preview -- <vault path> [data.json path]");
	process.exit(2);
}
const DATA = process.argv[3] ?? `${VAULT}/.obsidian/plugins/ben-vault-sync/data.json`;
const CONFIG_DIR = ".obsidian";
const PRUNED = new Set([".git", ".trash", "node_modules", ".obsidian-git-data"]);

const { settings, syncState } = migrateData(JSON.parse(readFileSync(DATA, "utf8")));

function walk(rel: string, out: string[]): void {
	for (const entry of readdirSync(join(VAULT, rel), { withFileTypes: true })) {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (PRUNED.has(entry.name)) continue;
			if (!settings.syncObsidianConfig && path === CONFIG_DIR) continue;
			walk(path, out);
		} else if (entry.isFile()) {
			out.push(path);
		}
	}
}

const all: string[] = [];
walk("", all);
const included = all.filter((p) => shouldSync(p, settings, CONFIG_DIR));
const untracked = included.filter((p) => !syncState.files[p]);

const sizeOf = (p: string): number => {
	try {
		return statSync(join(VAULT, p)).size;
	} catch {
		return 0;
	}
};
const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";
const totalNew = untracked.reduce((sum, p) => sum + sizeOf(p), 0);

const config = untracked.filter((p) => p.startsWith(CONFIG_DIR + "/"));
const notes = untracked.filter((p) => !p.startsWith(CONFIG_DIR + "/"));

console.log(`vault:                ${VAULT}`);
console.log(`syncObsidianConfig:   ${settings.syncObsidianConfig}`);
console.log(`files on disk:        ${all.length}`);
console.log(`included by rules:    ${included.length}`);
console.log(`already tracked:      ${Object.keys(syncState.files).length}`);
console.log(`would be uploaded:    ${untracked.length}  (${mb(totalNew)})`);
console.log(`  of that config:     ${config.length}  (${mb(config.reduce((s, p) => s + sizeOf(p), 0))})`);
console.log(`  of that notes:      ${notes.length}  (${mb(notes.reduce((s, p) => s + sizeOf(p), 0))})`);

const leak = included.filter((p) => p.includes(".vault-sync-backup"));
console.log(`token backup leaking: ${leak.length === 0 ? "no" : "YES -> " + leak.join(", ")}`);

const big = untracked.filter((p) => sizeOf(p) > 50 * 1048576);
console.log(`over the 50 MB limit: ${big.length === 0 ? "none" : big.join(", ")}`);

console.log("\nlargest uploads:");
for (const p of [...untracked].sort((a, b) => sizeOf(b) - sizeOf(a)).slice(0, 10)) {
	console.log(`  ${mb(sizeOf(p)).padStart(9)}  ${p}`);
}
