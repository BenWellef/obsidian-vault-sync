import { PLUGIN_ID, MARKER_FILE } from "./settings";
import { VaultSyncSettings } from "./types";

const VIDEO_EXT = new Set([
	"mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "mpg", "mpeg", "ogv",
]);
const AUDIO_EXT = new Set([
	"mp3", "wav", "m4a", "flac", "ogg", "oga", "opus", "aac", "aiff", "3gp", "wma",
]);
/** Extensions we treat as text, i.e. not gated behind the syncBinary switch. */
const TEXT_EXT = new Set([
	"md", "txt", "csv", "tsv", "json", "jsonc", "yml", "yaml", "toml", "xml", "svg",
	"css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "html", "htm", "canvas", "bib",
	"tex", "sty", "py", "java", "c", "h", "cpp", "hpp", "sh", "ps1", "bat", "ini",
	"cfg", "conf", "log", "srt", "vtt", "excalidraw",
]);

/** Files that are pure local noise and must never reach the repository. */
const NEVER_SYNC_BASENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Regenerable plugin caches at the vault root: never worth committing. */
const CACHE_FOLDERS = [".smart-env"];

/** Local-only backup folder, relative to the config dir. Contains a token copy. */
const BACKUP_FOLDER = "plugins/.vault-sync-backup";

/** Device-specific config that would otherwise ping-pong between machines forever. */
const CONFIG_EXCLUDES = new Set([
	"workspace.json",
	"workspace-mobile.json",
	"workspace.json.bak",
]);

export type Category = "text" | "video" | "audio" | "binary";

/**
 * Normalize to vault-relative POSIX form. v1 stored ignorePaths with a mix of
 * forward and backward slashes, so both have to be accepted on input.
 */
export function normalize(p: string): string {
	let out = p.replace(/\\/g, "/").trim();
	while (out.startsWith("./")) out = out.slice(2);
	while (out.startsWith("/")) out = out.slice(1);
	while (out.endsWith("/")) out = out.slice(0, -1);
	return out;
}

export function extensionOf(path: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	if (dot <= slash + 1) return "";
	return path.slice(dot + 1).toLowerCase();
}

export function basenameOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/** True for a preserved conflict copy such as `Note.conflict-remote.md`. */
export function isConflictSidecar(path: string): boolean {
	return /\.conflict-(remote|local)(\.[^./]+)?$/.test(path);
}

export function categoryOf(path: string): Category {
	const ext = extensionOf(path);
	if (VIDEO_EXT.has(ext)) return "video";
	if (AUDIO_EXT.has(ext)) return "audio";
	if (TEXT_EXT.has(ext)) return "text";
	return "binary";
}

/**
 * Prefix match against ignorePaths. An entry matches the path itself and
 * everything beneath it, so `Seminarfach/greenfoot` covers the whole folder.
 */
export function isIgnored(path: string, ignorePaths: string[]): boolean {
	for (const raw of ignorePaths) {
		const entry = normalize(raw);
		if (!entry) continue;
		if (path === entry || path.startsWith(entry + "/")) return true;
	}
	return false;
}

/**
 * Decide whether a vault-relative path takes part in syncing.
 *
 * `configDir` is Obsidian's own config folder name (normally `.obsidian`). In v1
 * the traversal skipped every dot folder outright, which silently defeated the
 * syncObsidianConfig switch - the config folder never reached the repository and
 * the plugin's own source was lost with it. v2 walks dot folders and filters here
 * instead, so the switch actually decides.
 */
export function shouldSync(
	path: string,
	settings: VaultSyncSettings,
	configDir: string
): boolean {
	if (!path) return false;
	if (NEVER_SYNC_BASENAMES.has(basenameOf(path))) return false;
	// A preserved conflict copy stays on the device that produced it. Syncing it
	// would let it conflict in turn and spawn a sidecar of a sidecar, which is
	// how "Hausaufgaben.conflict-remote.conflict-remote.md" came about.
	if (isConflictSidecar(path)) return false;

	// Local-only bookkeeping.
	if (path === MARKER_FILE) return false;
	if (path === ".git" || path.startsWith(".git/")) return false;
	if (path === ".gitignore" || path === ".gitattributes") return false;
	if (path.startsWith(".trash/")) return false;
	if (path.startsWith(".obsidian-git-data")) return false;
	for (const folder of CACHE_FOLDERS) {
		if (path === folder || path.startsWith(folder + "/")) return false;
	}

	const cfg = normalize(configDir);
	// A config folder below the vault root is a leftover from opening a subfolder
	// as its own vault. That is device-local workspace state, not vault content.
	if (path.includes("/" + cfg + "/")) return false;

	if (path === cfg || path.startsWith(cfg + "/")) {
		if (!settings.syncObsidianConfig) return false;
		const rel = path.slice(cfg.length + 1);
		if (CONFIG_EXCLUDES.has(rel)) return false;
		// The local backup of the lost v1 plugin holds a copy of its data.json, and
		// therefore a copy of the access token. It must never leave this machine.
		if (rel === BACKUP_FOLDER || rel.startsWith(BACKUP_FOLDER + "/")) return false;
		if (rel.endsWith(".js.map")) return false;

		if (rel.startsWith("plugins/")) {
			// Never ship our own data.json: it holds the access token in plain text.
			if (rel === `plugins/${PLUGIN_ID}/data.json`) return false;
			// Of a plugin folder only the identity and the settings are worth
			// syncing. Bundles, vendored libraries and shipped binaries are all
			// reinstallable from the community registry, and committing them would
			// pin tens of megabytes into the repository history permanently.
			// A self-written plugin is protected by its own source repository
			// instead, which is the lesson of losing v1 this way.
			const name = basenameOf(rel);
			if (name !== "manifest.json" && name !== "data.json") return false;
		}
	}

	if (isIgnored(path, settings.ignorePaths)) return false;

	switch (categoryOf(path)) {
		case "video":
			return settings.syncVideos;
		case "audio":
			return settings.syncAudio;
		case "binary":
			return settings.syncBinary;
		default:
			return true;
	}
}

/**
 * Sidecar path for a conflicting version, e.g.
 * `Hausaufgaben.md` -> `Hausaufgaben.conflict-remote.md`.
 * Matches the naming v1 left behind in the repository.
 */
export function conflictSidecar(path: string, side: "remote" | "local"): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	if (dot > slash + 1) {
		return `${path.slice(0, dot)}.conflict-${side}${path.slice(dot)}`;
	}
	return `${path}.conflict-${side}`;
}

