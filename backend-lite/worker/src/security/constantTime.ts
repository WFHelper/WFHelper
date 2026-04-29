const encoder = new TextEncoder();

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const [aHash, bHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);

	const left = new Uint8Array(aHash);
	const right = new Uint8Array(bHash);
	let diff = a.length ^ b.length;
	for (let i = 0; i < left.length; i += 1) {
		diff |= left[i] ^ right[i];
	}
	return diff === 0;
}
