// Copies the built plugin into the vault. Set VAULT to override the target.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const VAULT = process.env.VAULT ?? process.argv[2];
if (!VAULT) {
	console.error("set VAULT to the vault path, e.g. VAULT=/path/to/vault npm run deploy");
	process.exit(2);
}
const PLUGIN_ID = "ben-vault-sync";
const target = path.join(VAULT, ".obsidian", "plugins", PLUGIN_ID);

await mkdir(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	await copyFile(file, path.join(target, file));
	console.log(`copied ${file} -> ${target}`);
}
