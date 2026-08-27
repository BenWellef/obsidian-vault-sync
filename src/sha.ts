/**
 * Git blob hashing.
 *
 * The sync state stores git blob SHA-1s so a local file can be compared against
 * what the GitHub tree API reports without downloading anything.
 */

function rotl(n: number, s: number): number {
	return ((n << s) | (n >>> (32 - s))) >>> 0;
}

/** Pure-JS SHA-1, used when Web Crypto is unavailable. */
export function sha1Hex(data: Uint8Array): string {
	const ml = data.length;
	const total = Math.ceil((ml + 9) / 64) * 64;
	const buf = new Uint8Array(total);
	buf.set(data);
	buf[ml] = 0x80;

	const dv = new DataView(buf.buffer);
	const bits = ml * 8;
	dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
	dv.setUint32(total - 4, bits >>> 0);

	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;
	const w = new Uint32Array(80);

	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
		for (let i = 16; i < 80; i++) {
			w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
		}

		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;

		for (let i = 0; i < 80; i++) {
			let f: number;
			let k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
			e = d;
			d = c;
			c = rotl(b, 30);
			b = a;
			a = t;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}

	return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}

function toHex(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

let subtleUsable: boolean | null = null;

/**
 * `git hash-object` for a blob: SHA-1 over `blob <bytelength>\0` plus the content.
 * This is exactly the `sha` the GitHub tree and contents APIs report.
 */
export async function gitBlobSha(content: ArrayBuffer): Promise<string> {
	const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
	const buf = new Uint8Array(header.length + content.byteLength);
	buf.set(header, 0);
	buf.set(new Uint8Array(content), header.length);

	if (subtleUsable !== false && typeof crypto !== "undefined" && crypto.subtle) {
		try {
			const digest = await crypto.subtle.digest("SHA-1", buf);
			subtleUsable = true;
			return toHex(digest);
		} catch {
			// Non-secure context or SHA-1 disabled: fall back for the rest of the session.
			subtleUsable = false;
		}
	}
	return sha1Hex(buf);
}
