import { requestUrl, RequestUrlResponse } from "obsidian";
import { VaultSyncSettings } from "./types";

const API = "https://api.github.com";
/** Contents API refuses anything larger; flagged as an error rather than retried. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface RemoteEntry {
	sha: string;
	size: number;
}

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly retryable: boolean
	) {
		super(message);
		this.name = "GitHubError";
	}
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function toBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const CHUNK = 0x8000;
	let out = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(out);
}

export function fromBase64(b64: string): ArrayBuffer {
	const clean = b64.replace(/\s/g, "");
	const bin = atob(clean);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class GitHubClient {
	constructor(private settings: VaultSyncSettings) {}

	private get repoBase(): string {
		return `${API}/repos/${encodeURIComponent(this.settings.owner)}/${encodeURIComponent(
			this.settings.repo
		)}`;
	}

	private headers(accept: string): Record<string, string> {
		return {
			Authorization: `Bearer ${this.settings.token}`,
			Accept: accept,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "obsidian-ben-vault-sync",
		};
	}

	private describe(res: RequestUrlResponse): string {
		try {
			const msg = res.json?.message;
			if (typeof msg === "string") return msg;
		} catch {
			// Body was not JSON; fall through to the bare status.
		}
		return `HTTP ${res.status}`;
	}

	/** One request with backoff on rate limits, 5xx and branch-level write races. */
	private async request(
		method: string,
		url: string,
		opts: { body?: string; accept?: string; attempts?: number } = {}
	): Promise<RequestUrlResponse> {
		const accept = opts.accept ?? "application/vnd.github+json";
		const attempts = opts.attempts ?? 4;
		let lastError: GitHubError | null = null;

		for (let attempt = 0; attempt < attempts; attempt++) {
			const res = await requestUrl({
				url,
				method,
				headers: {
					...this.headers(accept),
					...(opts.body ? { "Content-Type": "application/json" } : {}),
				},
				body: opts.body,
				throw: false,
			});

			if (res.status >= 200 && res.status < 300) return res;

			// 409 means another writer moved the branch under us; 403/429 is throttling.
			const retryable =
				res.status >= 500 || res.status === 409 || res.status === 429 || res.status === 403;
			lastError = new GitHubError(this.describe(res), res.status, retryable);
			if (!retryable || attempt === attempts - 1) throw lastError;
			await sleep(500 * Math.pow(2, attempt));
		}

		throw lastError ?? new GitHubError("Request failed", 0, false);
	}

	/** Verifies token, repository and branch before any writing starts. */
	async checkAccess(): Promise<void> {
		await this.request("GET", this.repoBase);
		await this.request(
			"GET",
			`${this.repoBase}/branches/${encodeURIComponent(this.settings.branch)}`
		);
	}

	/**
	 * Whole-branch listing in one call. Returns the blob SHA per path, which is what
	 * makes a diff against the local vault possible without downloading anything.
	 */
	async listTree(): Promise<{ files: Map<string, RemoteEntry>; truncated: boolean }> {
		const res = await this.request(
			"GET",
			`${this.repoBase}/git/trees/${encodeURIComponent(this.settings.branch)}?recursive=1`
		);
		const files = new Map<string, RemoteEntry>();
		const tree = (res.json?.tree ?? []) as {
			path: string;
			type: string;
			sha: string;
			size?: number;
		}[];
		for (const entry of tree) {
			if (entry.type !== "blob") continue;
			files.set(entry.path, { sha: entry.sha, size: entry.size ?? 0 });
		}
		return { files, truncated: res.json?.truncated === true };
	}

	/** Raw blob bytes, safe for binary content. */
	async getBlob(sha: string): Promise<ArrayBuffer> {
		const res = await this.request("GET", `${this.repoBase}/git/blobs/${sha}`, {
			accept: "application/vnd.github.raw",
		});
		return res.arrayBuffer;
	}

	/**
	 * Create or update one file, producing one commit. `sha` must be the blob SHA
	 * currently on the branch when updating, omitted when creating.
	 * Returns the new blob SHA.
	 */
	async putFile(
		path: string,
		content: ArrayBuffer,
		sha: string | undefined,
		message: string
	): Promise<string> {
		if (content.byteLength > MAX_FILE_BYTES) {
			throw new GitHubError(
				`File is ${(content.byteLength / 1048576).toFixed(1)} MB, over the ${
					MAX_FILE_BYTES / 1048576
				} MB limit`,
				0,
				false
			);
		}
		const res = await this.request("PUT", `${this.repoBase}/contents/${encodePath(path)}`, {
			body: JSON.stringify({
				message,
				content: toBase64(content),
				branch: this.settings.branch,
				...(sha ? { sha } : {}),
			}),
		});
		const newSha = res.json?.content?.sha;
		if (typeof newSha !== "string") {
			throw new GitHubError("Upload response contained no blob SHA", res.status, false);
		}
		return newSha;
	}

	async deleteFile(path: string, sha: string, message: string): Promise<void> {
		await this.request("DELETE", `${this.repoBase}/contents/${encodePath(path)}`, {
			body: JSON.stringify({ message, sha, branch: this.settings.branch }),
		});
	}

	/**
	 * Commit timestamp of the newest commit touching `path`, in epoch ms.
	 * Only needed to arbitrate a conflict under the `newer` strategy.
	 */
	async lastCommitTime(path: string): Promise<number | null> {
		const res = await this.request(
			"GET",
			`${this.repoBase}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(
				this.settings.branch
			)}&per_page=1`
		);
		const commits = res.json as { commit?: { committer?: { date?: string } } }[];
		const date = commits?.[0]?.commit?.committer?.date;
		if (!date) return null;
		const ms = Date.parse(date);
		return Number.isNaN(ms) ? null : ms;
	}
}
