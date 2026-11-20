
/**
 * Builds an authorization URL for Google OAuth.
 */
export function getUpstreamAuthorizeUrl({
	upstreamUrl,
	clientId,
	scope,
	redirectUri,
	state,
	hostedDomain,
}: {
	upstreamUrl: string;
	clientId: string;
	scope: string;
	redirectUri: string;
	state?: string;
	hostedDomain?: string;
}): string {
	const upstream = new URL(upstreamUrl);

	upstream.searchParams.set("client_id", clientId);
	upstream.searchParams.set("redirect_uri", redirectUri);
	upstream.searchParams.set("scope", scope);
	upstream.searchParams.set("response_type", "code");

	// Request a refresh token from Google.
	upstream.searchParams.set("access_type", "offline");
	upstream.searchParams.set("prompt", "consent");

	if (state) upstream.searchParams.set("state", state);
	if (hostedDomain) upstream.searchParams.set("hd", hostedDomain);

	return upstream.href;
}

export interface GoogleTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
}

type TokenGrantType = "authorization_code" | "refresh_token";

/**
 * Exchanges an authorization code or refresh token with Google.
 */
export async function fetchUpstreamAuthToken({
	clientId,
	clientSecret,
	code,
	refreshToken,
	redirectUri,
	upstreamUrl,
	grantType,
}: {
	clientId: string;
	clientSecret: string;
	code?: string;
	refreshToken?: string;
	redirectUri?: string;
	upstreamUrl: string;
	grantType: TokenGrantType;
}): Promise<[GoogleTokenResponse, null] | [null, Response]> {
	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: grantType,
	});

	if (grantType === "authorization_code") {
		if (!code || !redirectUri) {
			return [
				null,
				new Response("Missing authorization code or redirect URI", {
					status: 400,
				}),
			];
		}

		params.set("code", code);
		params.set("redirect_uri", redirectUri);
	} else {
		if (!refreshToken) {
			return [
				null,
				new Response("Missing refresh token", {
					status: 400,
				}),
			];
		}

		params.set("refresh_token", refreshToken);
	}

	const response = await fetch(upstreamUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: params.toString(),
	});

	if (!response.ok) {
		// Do not log tokens, client secrets, or Google's raw response.
		console.error("Google token exchange failed:", response.status);

		return [
			null,
			new Response("Google token exchange failed", {
				status: 502,
			}),
		];
	}

	const body = (await response.json()) as GoogleTokenResponse;

	if (!body.access_token) {
		return [
			null,
			new Response("Google response did not contain an access token", {
				status: 502,
			}),
		];
	}

	return [body, null];
}

/**
 * Encrypts a token using AES-256-GCM.
 * Store the returned string in Cloudflare KV, never the plaintext token.
 */
export async function encryptToken(
	plainText: string,
	encryptionSecret: string,
): Promise<string> {
	if (!encryptionSecret) {
		throw new Error("TOKEN_ENCRYPTION_KEY is required");
	}

	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(encryptionSecret),
	);

	const key = await crypto.subtle.importKey(
		"raw",
		keyMaterial,
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);

	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoder.encode(plainText),
	);

	return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

/**
 * Decrypts a token previously encrypted by encryptToken().
 */
export async function decryptToken(
	encryptedValue: string,
	encryptionSecret: string,
): Promise<string> {
	if (!encryptionSecret) {
		throw new Error("TOKEN_ENCRYPTION_KEY is required");
	}

	const parts = encryptedValue.split(".");
	if (parts.length !== 2) {
		throw new Error("Invalid encrypted token format");
	}

	const [ivPart, cipherPart] = parts;
	const iv = base64ToBytes(ivPart);
	const ciphertext = base64ToBytes(cipherPart);

	if (iv.length !== 12) {
		throw new Error("Invalid encryption IV");
	}

	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(encryptionSecret),
	);

	const key = await crypto.subtle.importKey(
		"raw",
		keyMaterial,
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		ciphertext,
	);

	return new TextDecoder().decode(decrypted);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}
