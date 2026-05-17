import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEBUFF_BASE_URL = "https://www.codebuff.com";
const CODEBUFF_AGENT_ID = "codebuff/base@0.0.16";
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

interface LoginCodeResponse {
	loginUrl: string;
	fingerprintHash: string;
	expiresAt: number;
}

interface LoginStatusResponse {
	user?: { authToken?: string };
}

async function loginCodebuff(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const fingerprintId = crypto.randomUUID();

	const codeRes = await fetch(`${CODEBUFF_BASE_URL}/api/auth/cli/code`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fingerprintId }),
	});
	if (!codeRes.ok) {
		throw new Error(
			`Codebuff login code request failed: ${codeRes.status} ${await codeRes.text()}`,
		);
	}
	const { loginUrl, fingerprintHash, expiresAt } =
		(await codeRes.json()) as LoginCodeResponse;

	callbacks.onAuth({ url: loginUrl });

	const intervalMs = 3000;
	const deadline = Date.now() + 5 * 60 * 1000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, intervalMs));
		const params = new URLSearchParams({
			fingerprintId,
			fingerprintHash,
			expiresAt: String(expiresAt),
		});
		const statusRes = await fetch(
			`${CODEBUFF_BASE_URL}/api/auth/cli/status?${params.toString()}`,
		);
		if (!statusRes.ok) continue;
		const data = (await statusRes.json()) as LoginStatusResponse;
		const authToken = data.user?.authToken;
		if (typeof authToken === "string" && authToken.length > 0) {
			return {
				refresh: authToken,
				access: authToken,
				expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
			};
		}
	}
	throw new Error("Codebuff login timed out — please run /login codebuff again.");
}

function readCodebuffToken(): string | undefined {
	try {
		const raw = readFileSync(AUTH_FILE, "utf8");
		const parsed = JSON.parse(raw) as Record<
			string,
			{ type?: string; key?: string; access?: string }
		>;
		const cred = parsed.codebuff;
		if (!cred) return undefined;
		if (cred.type === "oauth") return cred.access;
		if (cred.type === "api_key") return cred.key;
		return undefined;
	} catch {
		return undefined;
	}
}

async function startAgentRun(authToken: string): Promise<string> {
	const res = await fetch(`${CODEBUFF_BASE_URL}/api/v1/agent-runs`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${authToken}`,
		},
		body: JSON.stringify({ action: "START", agentId: CODEBUFF_AGENT_ID }),
	});
	if (!res.ok) {
		throw new Error(
			`Codebuff agent-runs START failed: ${res.status} ${await res.text()}`,
		);
	}
	const data = (await res.json()) as { runId: string };
	return data.runId;
}

async function finishAgentRun(authToken: string, runId: string): Promise<void> {
	try {
		await fetch(`${CODEBUFF_BASE_URL}/api/v1/agent-runs`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify({
				action: "FINISH",
				runId,
				status: "completed",
				totalSteps: 0,
				directCredits: 0,
				totalCredits: 0,
			}),
		});
	} catch {
		// best-effort; codebuff cleans up stale runs server-side
	}
}

export default function (pi: ExtensionAPI) {
	let runId: string | undefined;
	let cachedToken: string | undefined;
	let startPromise: Promise<string> | undefined;
	const clientId = crypto.randomUUID();

	pi.registerProvider("codebuff", {
		name: "Codebuff",
		baseUrl: `${CODEBUFF_BASE_URL}/api/v1`,
		apiKey: "CODEBUFF_API_KEY",
		api: "openai-completions",
		headers: {
			"user-agent": "ai-sdk/openai-compatible/0.10.7/codebuff",
		},
		models: [
			{
				id: "anthropic/claude-opus-4.7",
				name: "Claude Opus 4.7 (Codebuff)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 200000,
				maxTokens: 32000,
				compat: { cacheControlFormat: "anthropic" },
			},
			{
				id: "anthropic/claude-sonnet-4.6",
				name: "Claude Sonnet 4.6 (Codebuff)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 32000,
				compat: { cacheControlFormat: "anthropic" },
			},
		],
		oauth: {
			name: "Codebuff",
			login: loginCodebuff,
			refreshToken: async (cred) => cred,
			getApiKey: (cred) => cred.access,
		},
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = (ctx as { model?: { provider?: string } }).model;
		if (!model || model.provider !== "codebuff") return;

		if (!cachedToken) cachedToken = readCodebuffToken();
		if (!cachedToken) return; // pi will surface 401 from codebuff

		if (!runId) {
			if (!startPromise) startPromise = startAgentRun(cachedToken);
			runId = await startPromise;
		}

		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const existingMeta =
			(payload.codebuff_metadata as Record<string, unknown> | undefined) ?? {};
		const existingProvider =
			(payload.provider as Record<string, unknown> | undefined) ?? {};
		return {
			...payload,
			codebuff_metadata: {
				...existingMeta,
				run_id: runId,
				client_id: clientId,
			},
			provider: {
				allow_fallbacks: true,
				...existingProvider,
			},
			usage: { include: true },
		};
	});

	pi.on("session_shutdown", async () => {
		if (runId && cachedToken) {
			const id = runId;
			const token = cachedToken;
			runId = undefined;
			startPromise = undefined;
			await finishAgentRun(token, id);
		}
	});
}
