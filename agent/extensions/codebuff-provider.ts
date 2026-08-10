import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	stream as streamOpenAICompletions,
	streamSimple as streamSimpleOpenAICompletions,
} from "/Users/bgdn0083/.asdf/installs/nodejs/24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEBUFF_BASE_URL = "https://www.codebuff.com";
const CODEBUFF_AGENT_ID = "codebuff/base@0.0.16";
const CODEBUFF_USER_AGENT =
	"ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.20 runtime/node";
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

/** OpenRouter inner provider order for Codebuff requests. */
const PROVIDER_ORDER: Record<string, string[]> = {
	"anthropic/claude-sonnet-4.6": ["Google", "Anthropic", "Amazon Bedrock"],
	"anthropic/claude-opus-4.7": ["Google", "Anthropic"],
	"z-ai/glm-5.2": ["baseten/fast"],
	"deepseek/deepseek-v4-flash-0731": ["Novita"],
};

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

/** Raw HTTP client for Codebuff billing/session APIs (not the @codebuff/sdk agent harness). */
class CodebuffRunSession {
	readonly clientId = crypto.randomUUID();
	readonly traceSessionId = crypto.randomUUID();
	private runId: string | undefined;
	private cachedToken: string | undefined;
	private startPromise: Promise<string> | undefined;

	get activeRunId(): string | undefined {
		return this.runId;
	}

	resolveToken(explicit?: string): string | undefined {
		if (explicit) return explicit;
		if (!this.cachedToken) this.cachedToken = readCodebuffToken();
		return this.cachedToken;
	}

	prefetchRun(token?: string): void {
		const authToken = this.resolveToken(token);
		if (!authToken || this.runId || this.startPromise) return;
		this.startPromise = startAgentRun(authToken).then((id) => {
			this.runId = id;
			return id;
		});
	}

	async ensureRunId(token?: string): Promise<string> {
		const authToken = this.resolveToken(token);
		if (!authToken) {
			throw new Error("Codebuff auth token missing — run /login codebuff");
		}
		if (this.runId) return this.runId;
		if (!this.startPromise) {
			this.startPromise = startAgentRun(authToken).then((id) => {
				this.runId = id;
				return id;
			});
		}
		return this.startPromise;
	}

	async enrichPayload(
		payload: Record<string, unknown>,
		modelId: string,
		token?: string,
	): Promise<Record<string, unknown>> {
		const runId = await this.ensureRunId(token);
		const existingMeta =
			(payload.codebuff_metadata as Record<string, unknown> | undefined) ?? {};
		const providerOrder = PROVIDER_ORDER[modelId];
		const enriched = {
			...payload,
			codebuff_metadata: {
				...existingMeta,
				run_id: runId,
				client_id: this.clientId,
				trace_session_id: this.traceSessionId,
			},
			provider: {
				allow_fallbacks: false,
				data_collection: "deny",
				...(providerOrder ? { order: providerOrder } : {}),
			},
			usage: { include: true },
		};
		return modelId === "z-ai/glm-5.2"
			? sanitizeGlm52Payload(enriched)
			: enriched;
	}

	async finish(token?: string): Promise<void> {
		if (!this.runId) return;
		const authToken = this.resolveToken(token);
		if (!authToken) return;
		const id = this.runId;
		this.runId = undefined;
		this.startPromise = undefined;
		await finishAgentRun(authToken, id);
	}
}

async function startAgentRun(authToken: string): Promise<string> {
	const res = await fetch(`${CODEBUFF_BASE_URL}/api/v1/agent-runs`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${authToken}`,
		},
		body: JSON.stringify({
			action: "START",
			agentId: CODEBUFF_AGENT_ID,
			ancestorRunIds: [],
		}),
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

function sanitizeGlm52Payload(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	if (!Array.isArray(payload.messages)) return payload;

	return {
		...payload,
		messages: payload.messages.map((message) => {
			if (
				!message ||
				typeof message !== "object" ||
				(message as { role?: unknown }).role !== "assistant"
			) {
				return message;
			}

			const next = { ...(message as Record<string, unknown>) };
			// GLM 5.2 via Codebuff/OpenRouter accepts reasoning controls on the
			// request, but rejects replayed assistant reasoning fields on the next
			// turn (Codebuff returns 400 with an empty body). Keep only normal chat
			// content/tool calls in history.
			delete next.reasoning;
			delete next.reasoning_content;
			delete next.reasoning_text;
			delete next.reasoning_details;

			// z.ai-compatible chat endpoints are stricter than OpenAI about assistant
			// tool-call messages: `content: null` can make the follow-up request fail.
			if (next.content == null && Array.isArray(next.tool_calls)) {
				next.content = "";
			}

			return next;
		}),
	};
}

function debugCodebuffPayload(
	modelId: string,
	payload: Record<string, unknown>,
): void {
	debugCodebuff(modelId, "payload", payload);
}

function debugCodebuff(
	modelId: string,
	kind: string,
	data: Record<string, unknown>,
): void {
	const debugDir = process.env.CODEBUFF_DEBUG_DIR;
	if (!debugDir || modelId !== "z-ai/glm-5.2") return;
	try {
		mkdirSync(debugDir, { recursive: true });
		writeFileSync(
			join(debugDir, `${kind}-${Date.now()}.json`),
			`${JSON.stringify(data, null, 2)}\n`,
		);
	} catch {
		// Debug logging must never break provider calls.
	}
}

/**
 * Stream via pi-ai's OpenAI-completions serializer, but inject Codebuff fields
 * before the request is sent. HTTP still targets /api/v1/chat/completions through pi's
 * OpenAI client — the same backend path as @codebuff/sdk createCodebuffBackendModel,
 * not client.run() / callMainPrompt (the local agent harness).
 */
function withCodebuffPayloadHook<TOptions extends StreamOptions>(
	session: CodebuffRunSession,
	model: Model<"openai-completions">,
	options?: TOptions,
): TOptions {
	return {
		...options,
		onPayload: async (payload, payloadModel) => {
			let next = await session.enrichPayload(
				(payload ?? {}) as Record<string, unknown>,
				model.id,
				options?.apiKey,
			);
			if (options?.onPayload) {
				next =
					((await options.onPayload(next, payloadModel)) as
						| Record<string, unknown>
						| undefined) ?? next;
			}
			if (model.id === "z-ai/glm-5.2") {
				next = sanitizeGlm52Payload(next);
			}
			debugCodebuffPayload(model.id, next);
			return next;
		},
	} as TOptions;
}

function createCodebuffStream(session: CodebuffRunSession) {
	return (
		model: Model<"openai-completions">,
		context: Context,
		options?: StreamOptions,
	) => {
		debugCodebuff(model.id, "stream", {
			messageCount: context.messages.length,
			lastRole: context.messages.at(-1)?.role,
		});
		return streamOpenAICompletions(
			model,
			context,
			withCodebuffPayloadHook(session, model, options),
		);
	};
}

function createCodebuffStreamSimple(session: CodebuffRunSession) {
	return (
		model: Model<"openai-completions">,
		context: Context,
		options?: SimpleStreamOptions,
	) => {
		debugCodebuff(model.id, "streamSimple", {
			messageCount: context.messages.length,
			lastRole: context.messages.at(-1)?.role,
		});
		return streamSimpleOpenAICompletions(
			model,
			context,
			withCodebuffPayloadHook(session, model, options),
		);
	};
}

export default function (pi: ExtensionAPI) {
	const session = new CodebuffRunSession();
	session.prefetchRun();

	pi.registerProvider("codebuff", {
		name: "Codebuff",
		baseUrl: `${CODEBUFF_BASE_URL}/api/v1`,
		apiKey: "CODEBUFF_API_KEY",
		api: "openai-completions",
		authHeader: true,
		stream: createCodebuffStream(session),
		streamSimple: createCodebuffStreamSimple(session),
		headers: {
			"user-agent": CODEBUFF_USER_AGENT,
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
				compat: {
					cacheControlFormat: "anthropic",
					// Codebuff routes through an OpenRouter-like backend that does not
					// honor the OpenAI `developer` role. Without this, pi-ai's
					// detectCompat() sees a non-OpenRouter, non-nonStandard provider and
					// sends the system prompt (which contains <available_skills>) as
					// role="developer", which the upstream model ignores — so skills,
					// guidelines, and project context silently disappear.
					supportsDeveloperRole: false,
				},
			},
			{
				id: "anthropic/claude-sonnet-4.6",
				name: "Claude Sonnet 4.6 (Codebuff)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 32000,
				compat: {
					cacheControlFormat: "anthropic",
					supportsDeveloperRole: false,
				},
			},
			{
				id: "z-ai/glm-5.2",
				name: "GLM 5.2 (Codebuff)",
				reasoning: true,
				thinkingLevelMap: {
					minimal: null,
					low: null,
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
				},
				input: ["text"],
				cost: { input: 1.2, output: 4.1, cacheRead: 0.2, cacheWrite: 1.2 },
				contextWindow: 1048576,
				maxTokens: 131072,
				compat: {
					thinkingFormat: "openrouter",
					supportsReasoningEffort: true,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "moonshotai/kimi-k3",
				name: "Kimi K3 (Codebuff)",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: null,
					medium: null,
					high: null,
					xhigh: null,
					max: "max",
				},
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
				compat: {
					thinkingFormat: "deepseek",
					requiresReasoningContentOnAssistantMessages: true,
					deferredToolsMode: "kimi",
					supportsDeveloperRole: false,
				},
			},
			{
				id: "x-ai/grok-4.5",
				name: "Grok 4.5 (Codebuff)",
				reasoning: true,
				thinkingLevelMap: {
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "high",
				},
				input: ["text", "image"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
				contextWindow: 500000,
				maxTokens: 131072,
				compat: {
					thinkingFormat: "openrouter",
					supportsReasoningEffort: true,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "meta/muse-spark-1.2",
				name: "Muse Spark 1.2 (Codebuff)",
				reasoning: true,
				thinkingLevelMap: {
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
				},
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
				// OpenRouter-like backend (same as GLM 5.2/Grok 4.5): reasoning is
				// controlled via the normalized `reasoning` object, and the backend
				// ignores the OpenAI `developer` role.
				compat: {
					thinkingFormat: "openrouter",
					supportsReasoningEffort: true,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "deepseek/deepseek-v4-flash-0731",
				name: "DeepSeek V4 Flash 07/31 (Codebuff)",
				reasoning: true,
				thinkingLevelMap: {
					minimal: null,
					low: null,
					medium: null,
					high: "high",
					xhigh: "xhigh",
					max: null,
				},
				input: ["text"],
				cost: { input: 0.09, output: 0.18, cacheRead: 0.018, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 65536,
				// Forced to Novita via PROVIDER_ORDER (OpenRouter provider name is
				// "Novita", not "NovitaAI"). "DeepSeek" yields no routeable
				// endpoints (404 "No endpoints found") through this backend.
				// OpenRouter-like backend, so thinking/reasoning_content follow the
				// openrouter format.
				compat: {
					thinkingFormat: "openrouter",
					requiresReasoningContentOnAssistantMessages: true,
					supportsDeveloperRole: false,
				},
			},
		],
		oauth: {
			name: "Codebuff",
			login: loginCodebuff,
			refreshToken: async (cred) => cred,
			getApiKey: (cred) => cred.access,
		},
	});

	pi.on("session_start", () => {
		session.prefetchRun();
	});

	pi.on("session_shutdown", async () => {
		await session.finish();
	});
}
