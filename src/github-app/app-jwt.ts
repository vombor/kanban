// The GitHub App's JWT (RS256, signed with the app's private key): GitHub accepts it for the app endpoints
// (`/app/...`, `/repos/{owner}/{repo}/installation`) for at most 10 minutes. `iat` is set 60 s back for clock drift,
// as GitHub recommends; `exp` 9 minutes ahead, so a slow clock still stays under the limit.
import { createSign } from "node:crypto";

function base64Url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(input: { appId: number; privateKey: string; now?: number }): string {
	const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
	const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64Url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: String(input.appId) }));
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	return `${header}.${payload}.${base64Url(signer.sign(input.privateKey))}`;
}
