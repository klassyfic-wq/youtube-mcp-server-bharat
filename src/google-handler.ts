
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
	encryptToken,
	fetchUpstreamAuthToken,
	getUpstreamAuthorizeUrl,
	type GoogleTokenResponse,
	type Props,
} from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

const GOOGLE_SCOPES = [
	"email",
	"profile",
	"https://www.googleapis.com/auth/youtube",
	"https://www.googleapis.com/auth/youtube.upload",
].join(" ");

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;

	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);

		return redirectToGoogle(c.req.raw, c.env, stateToken, {
			"Set-Cookie": setCookie,
		});
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Connect Claude to your YouTube channel.",
			name: "YouTube MCP Server Bharat",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();

		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");

		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };

		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo?.clientId) {
			return c.text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToGoogle(c.req.raw, c.env, stateToken, headers);
	} catch (error) {
		console.error("POST /authorize error:", error);

		if (error instanceof OAuthError) {
			return error.toResponse();
		}

		return c.text("Internal server error", 500);
	}
});

async function redirectToGoogle(
	request: Request,
	env: Env,
	stateToken: string,
	responseHeaders?: HeadersInit,
) {
	const headers = new Headers(responseHeaders);

	headers.set(
		"Location",
		getUpstreamAuthorizeUrl({
			clientId: env.GOOGLE_CLIENT_ID,
			hostedDomain: env.HOSTED_DOMAIN,
			redirectUri: new URL("/callback", request.url).href,
			scope: GOOGLE_SCOPES,
			state: stateToken,
			upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		}),
	);

	return new Response(null, {
		headers,
		status: 302,
	});
}

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}

		console.error("OAuth state validation failed");
		return c.text("OAuth state validation failed", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	const googleError = c.req.query("error");
	if (googleError) {
		return c.text(`Google authorization failed: ${googleError}`, 400);
	}

	const code = c.req.query("code");

	if (!code) {
		return c.text("Missing authorization code", 400);
	}

	const [tokenResponse, googleErrResponse] = await fetchUpstreamAuthToken({
		clientId: c.env.GOOGLE_CLIENT_ID,
		clientSecret: c.env.GOOGLE_CLIENT_SECRET,
		code,
		grantType: "authorization_code",
		redirectUri: new URL("/callback", c.req.url).href,
		upstreamUrl: "https://accounts.google.com/o/oauth2/token",
	});

	if (googleErrResponse) {
		return googleErrResponse;
	}

	if (!tokenResponse?.access_token) {
		return c.text("Google did not return an access token", 502);
	}

	const accessToken = tokenResponse.access_token;

	const userResponse = await fetch(
		"https://www.googleapis.com/oauth2/v2/userinfo",
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!userResponse.ok) {
		console.error("Google userinfo request failed:", userResponse.status);
		return c.text("Failed to fetch Google user information", 502);
	}

	const user = (await userResponse.json()) as {
		id: string;
		name: string;
		email: string;
	};

	if (!user.id || !user.email) {
		return c.text("Google user information is incomplete", 502);
	}

	// Persist the refresh token using application-layer encryption.
	const refreshTokenKey = `google:refresh:${user.id}`;
	const existingRefreshToken = await c.env.OAUTH_KV.get(refreshTokenKey);

	if (tokenResponse.refresh_token) {
		const encryptedRefreshToken = await encryptToken(
			tokenResponse.refresh_token,
			c.env.TOKEN_ENCRYPTION_KEY,
		);

		await c.env.OAUTH_KV.put(refreshTokenKey, encryptedRefreshToken);
	} else if (!existingRefreshToken) {
		console.error("Google did not provide a refresh token");
		return c.text(
			"Google did not provide a refresh token. Revoke this app's Google access and authorize again.",
			502,
		);
	}

	const props: Props = {
		accessToken,
		email: user.email,
		name: user.name,
	};

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: user.name,
		},
		props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: user.id,
	});

	const headers = new Headers({
		Location: redirectTo,
	});

	if (clearSessionCookie) {
		headers.append("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GoogleHandler };
