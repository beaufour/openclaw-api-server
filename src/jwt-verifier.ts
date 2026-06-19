/**
 * Google OIDC JWT verifier using google-auth-library.
 *
 * Validates JWT tokens sent by Google Cloud Pub/Sub push subscriptions.
 */

import { OAuth2Client } from "google-auth-library";
import type { JwtVerifier } from "./handlers/gmail.js";

const client = new OAuth2Client();

export const googleJwtVerifier: JwtVerifier = {
	async verify(token: string, audience: string): Promise<{ email?: string }> {
		const ticket = await client.verifyIdToken({
			idToken: token,
			audience,
		});
		const payload = ticket.getPayload();
		return { email: payload?.email };
	},
};
