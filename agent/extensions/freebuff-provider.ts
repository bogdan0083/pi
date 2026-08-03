/**
 * Freebuff provider for pi — free models from Codebuff's free-only Freebuff tier.
 *
 * Reverse-engineered from CodebuffAI/codebuff (freebuff CLI + sdk + common
 * packages) and verified live against the production backend. Freebuff has no
 * public API; its CLI gates free ("0 credits") traffic behind a session
 * protocol. This extension implements that protocol:
 *
 *   1. POST /api/v1/freebuff/session  (header `x-freebuff-model: <model>`)
 *      Admits the account into a 1-hour free session for one model and returns
 *      an `instanceId`. One session per account (CLI tier): a new POST
 *      supersedes the previous instance (409 `session_superseded` for stale
 *      instance ids), and POSTing while another model holds the slot fails
 *      with 409 `model_locked` until the slot is DELETE'd.
 *      Chat without a live session fails with 428 `waiting_room_required`.
 *   2. POST /api/v1/agent-runs  { action: "START", agentId: <free-mode root
 *      agent>, ancestorRunIds: [] } → runId. Every free-mode completion must
 *      reference a run whose agent is allowlisted for the model
 *      (FREE_MODE_AGENT_MODELS), otherwise 403 `free_mode_invalid_agent_model`.
 *      Unknown run ids → 400 "runId Not Found".
 *   3. POST /api/v1/chat/completions (OpenAI-compatible) with extra body
 *      fields:
 *        codebuff_metadata: { freebuff_instance_id, run_id, client_id,
 *                             trace_session_id, cost_mode: "free" }
 *        provider: { allow_fallbacks: true }
 *      and — anti-abuse gate — the first system message must open with the
 *      canonical Buffy marker (FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS), so the
 *      marker is prepended to pi's system prompt (pi's prompt follows intact).
 *
 * The server answers `usage.cost: 0` on these requests — that is the free
 * tier doing its accounting. Models a user's access tier can't select are
 * silently coerced to the fallback by the session endpoint, so admission
 * responses whose model differs from the requested one are treated as errors
 * instead of silently streaming from the wrong model.
 *
 * Auth: any Codebuff account token works (Freebuff CLI and Codebuff CLI share
 * accounts). Resolution order: CODEBUFF_API_KEY env / pi's stored `freebuff`
 * credential (/login freebuff) → pi's stored `codebuff` credential → the
 * Freebuff CLI's own ~/.config/manicode/credentials.json. On first load the
 * CLI credential is seeded into pi's auth store when pi has none, so the
 * provider works out of the box for Freebuff CLI users.
 *
 * UI: while a freebuff model is selected, a footer status line shows the slot
 * countdown and daily quota (GET /api/v1/freebuff/session, refreshed every
 * 60s); /freebuff prints a full details card (status, time left, tier, quota,
 * entitlements) as a custom entry that never enters the LLM context.
 *
 * Resilience: the slot is account-wide and can vanish mid-conversation
 * (hourly sweep, Freebuff CLI re-admission, or another pi process releasing
 * it). Slot-loss responses (428 waiting_room_required, 409
 * session_superseded) arrive before any stream content, so they are retried
 * once transparently after re-admission. Shutdown releases are
 * ownership-checked: this process only DELETEs the slot when the live
 * instance is the one it admitted, so short-lived/nested pi runs never kill
 * a sibling's (or the CLI's) session.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAICompletions } from "/Users/bgdn0083/.asdf/installs/nodejs/24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createAssistantMessageEventStream } from "/Users/bgdn0083/.asdf/installs/nodejs/24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import { Box, Text } from "/Users/bgdn0083/.asdf/installs/nodejs/24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEBUFF_BASE_URL = "https://www.codebuff.com";
const CODEBUFF_USER_AGENT =
	"ai-sdk/openai-compatible/0.10.7/codebuff ai-sdk/provider-utils/3.0.20 runtime/node";
const PI_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const MANICODE_CREDENTIALS_FILE = join(
	homedir(),
	".config",
	"manicode",
	"credentials.json",
);

/** Canonical opening the free-mode gate requires at position 0 of the first
 *  system message (FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS). */
const FREEBUFF_SYSTEM_MARKER =
	"You are Buffy, the strategic coding assistant.";

/** Re-admit when the 1-hour slot has less than this left. */
const SESSION_REFRESH_MARGIN_MS = 120_000;

/** Free-mode root agent per model (FREEBUFF_ROOT_AGENT_ID_BY_MODEL). */
const FREEBUFF_AGENT_BY_MODEL: Record<string, string> = {
	"deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
	"mimo/mimo-v2.5": "base2-free-mimo",
	"deepseek/deepseek-v4-pro": "base2-free-deepseek",
	"minimax/minimax-m3": "base2-free-minimax-m3",
	"openai/gpt-5.6-luna": "base2-free-luna",
	"z-ai/glm-5.2": "base2-free-glm",
	"anthropic/claude-fable-5": "base2-free-fable",
};

/** Models selectable on the limited access tier (for error messages). */
const LIMITED_TIER_MODELS = ["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface LoginCodeResponse {
	loginUrl: string;
	fingerprintHash: string;
	expiresAt: number;
}

interface LoginStatusResponse {
	user?: { authToken?: string };
}

async function loginFreebuff(
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
			`Freebuff login code request failed: ${codeRes.status} ${await codeRes.text()}`,
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
	throw new Error("Freebuff login timed out — please run /login freebuff again.");
}

type PiAuthStore = Record<
	string,
	{ type?: string; key?: string; access?: string; refresh?: string; expires?: number }
>;

function readPiAuthStore(): PiAuthStore {
	try {
		return JSON.parse(readFileSync(PI_AUTH_FILE, "utf8")) as PiAuthStore;
	} catch {
		return {};
	}
}

function readManicodeToken(): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(MANICODE_CREDENTIALS_FILE, "utf8")) as {
			default?: { authToken?: string };
		};
		return parsed.default?.authToken || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Make pi's auth resolution see the Freebuff CLI credential: pi refuses to
 * stream from an unconfigured provider before the extension's own fallback
 * would run, so seed auth.json with the CLI token when pi has no freebuff or
 * codebuff credential of its own. Never overwrites existing entries.
 */
function seedAuthFromManicode(): void {
	try {
		const store = readPiAuthStore();
		if (store.freebuff || store.codebuff) return;
		const token = readManicodeToken();
		if (!token) return;
		store.freebuff = { type: "api_key", key: token };
		mkdirSync(dirname(PI_AUTH_FILE), { recursive: true });
		const tmp = `${PI_AUTH_FILE}.freebuff-seed-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, PI_AUTH_FILE);
	} catch {
		// Seeding is best-effort; /login freebuff remains the explicit path.
	}
}

function resolveFreebuffToken(explicit?: string): string | undefined {
	if (explicit) return explicit;
	const store = readPiAuthStore();
	for (const key of ["freebuff", "codebuff"]) {
		const cred = store[key];
		if (!cred) continue;
		if (cred.type === "oauth" && cred.access) return cred.access;
		if (cred.type === "api_key" && cred.key) return cred.key;
	}
	return readManicodeToken();
}

// ---------------------------------------------------------------------------
// Live session details (GET) — powers the status line and /freebuff
// ---------------------------------------------------------------------------

interface FreebuffQuota {
	limit?: number;
	recentCount?: number;
	resetAt?: string;
	resetTimeZone?: string;
	entitlementBreakdown?: { base?: number; referral?: number; streak?: number };
}

interface FreebuffSessionDetails {
	status?: string;
	accessTier?: string;
	instanceId?: string;
	model?: string;
	admittedAt?: string;
	expiresAt?: string;
	rateLimit?: FreebuffQuota;
	rateLimitsByModel?: Record<string, FreebuffQuota>;
}

/**
 * Quota for the relevant model. Active sessions carry a top-level `rateLimit`;
 * the idle response only has per-model entries under `rateLimitsByModel`.
 */
function pickQuota(
	d: FreebuffSessionDetails | undefined,
	modelId?: string,
): FreebuffQuota | undefined {
	if (!d) return undefined;
	if (d.rateLimit) return d.rateLimit;
	const byModel = d.rateLimitsByModel;
	if (!byModel) return undefined;
	if (modelId && byModel[modelId]) return byModel[modelId];
	return Object.values(byModel)[0];
}

/** Fetch the account's live freebuff state (active slot + daily quota). */
async function fetchFreebuffSessionDetails(
	token: string,
): Promise<FreebuffSessionDetails | undefined> {
	try {
		const res = await fetch(`${CODEBUFF_BASE_URL}/api/v1/freebuff/session`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return undefined;
		return (await res.json()) as FreebuffSessionDetails;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Freebuff session admission (one 1-hour slot per account)
// ---------------------------------------------------------------------------

interface FreebuffAdmission {
	instanceId: string;
	model: string;
	expiresAtMs: number;
}

class FreebuffSessionManager {
	private session: FreebuffAdmission | undefined;
	private details: FreebuffSessionDetails | undefined;
	private inflight: Promise<FreebuffAdmission> | undefined;

	snapshot(): {
		admission: FreebuffAdmission | undefined;
		details: FreebuffSessionDetails | undefined;
	} {
		return { admission: this.session, details: this.details };
	}

	invalidate(): void {
		this.session = undefined;
		this.details = undefined;
	}

	async ensureInstanceId(modelId: string, token: string): Promise<string> {
		const cached = this.session;
		if (
			cached &&
			cached.model === modelId &&
			cached.expiresAtMs - Date.now() > SESSION_REFRESH_MARGIN_MS
		) {
			return cached.instanceId;
		}
		if (!this.inflight) {
			this.inflight = this.admit(modelId, token).finally(() => {
				this.inflight = undefined;
			});
		}
		const admitted = await this.inflight;
		if (admitted.model !== modelId) {
			// A concurrent admission for another model won the slot; take it back.
			return this.ensureInstanceId(modelId, token);
		}
		return admitted.instanceId;
	}

	private async admit(
		modelId: string,
		token: string,
		afterLockRetry = false,
	): Promise<FreebuffAdmission> {
		const res = await fetch(`${CODEBUFF_BASE_URL}/api/v1/freebuff/session`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"x-freebuff-model": modelId,
			},
		});
		const body = (await res.json().catch(() => undefined)) as
			| Record<string, unknown>
			| undefined;
		const status = typeof body?.status === "string" ? body.status : undefined;

		if (res.status === 409 && status === "model_locked" && !afterLockRetry) {
			// Slot held on another model — release and re-claim, exactly what the
			// Freebuff CLI picker does on a deliberate model switch. Forced:
			// the user explicitly asked pi for this model, so the foreign-held
			// slot is deliberately taken over.
			await this.release(token, true);
			return this.admit(modelId, token, true);
		}

		if (res.status === 403 && (status === "country_blocked" || status === "banned")) {
			const reason =
				typeof body?.countryBlockReason === "string"
					? ` (${body.countryBlockReason})`
					: "";
			throw new Error(
				`Freebuff is unavailable for this account/IP: ${status}${reason}.`,
			);
		}

		if (
			res.status === 429 &&
			(status === "rate_limited" || status === "spend_limited" || status === "ip_capped")
		) {
			throw new Error(`Freebuff session quota exhausted: ${describeRateLimit(body)}`);
		}

		if (res.status === 409 && status === "model_unavailable") {
			throw new Error(
				`Freebuff model "${modelId}" is unavailable right now (pool spent or gated). ` +
					`Available on the limited tier: ${LIMITED_TIER_MODELS.join(", ")}.`,
			);
		}

		if (res.status === 401) {
			throw new Error(
				"Freebuff rejected the auth token — run /login freebuff (or sign into the freebuff CLI again).",
			);
		}

		if (!res.ok) {
			const detail = body ? JSON.stringify(body).slice(0, 300) : await res.text().catch(() => "");
			throw new Error(`Freebuff session admission failed: ${res.status} ${detail}`);
		}

		if (status !== "active" || typeof body?.instanceId !== "string") {
			throw new Error(
				`Freebuff session admission returned an unexpected state: ${JSON.stringify(body)?.slice(0, 300)}`,
			);
		}

		if (body.model !== modelId) {
			// The server silently coerces unselectable models (tier gates, referral
			// locks) to the fallback model. Never stream from the wrong model.
			throw new Error(
				`Freebuff model "${modelId}" is not available on your access tier ` +
					`(${typeof body.accessTier === "string" ? body.accessTier : "unknown"}). ` +
					`Available models: ${LIMITED_TIER_MODELS.join(", ")} (or unlock more via referrals/tier).`,
			);
		}

		const expiresAtMs =
			typeof body.expiresAt === "string"
				? Date.parse(body.expiresAt)
				: Date.now() + 3_600_000;
		this.session = {
			instanceId: body.instanceId,
			model: modelId,
			expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 3_600_000,
		};
		this.details = body as FreebuffSessionDetails;
		return this.session;
	}

	async release(token?: string, force = false): Promise<void> {
		// The slot is account-wide, and DELETE kills whatever session the
		// account currently has — including one admitted by the Freebuff CLI or
		// another pi process. Unless forced (deliberate model switch), only
		// release when this process actually admitted a session AND the live
		// slot is still that exact instance. (A pi that never made a freebuff
		// request must not free the slot on exit — e.g. short-lived `pi -p`
		// runs spawned by the agent's bash tool.)
		const owned = this.session;
		this.session = undefined;
		this.details = undefined;
		const authToken = token ?? resolveFreebuffToken();
		if (!authToken || !owned) return;
		if (force) {
			try {
				await fetch(`${CODEBUFF_BASE_URL}/api/v1/freebuff/session`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${authToken}` },
				});
			} catch {
				// best-effort
			}
			return;
		}
		try {
			const check = await fetch(`${CODEBUFF_BASE_URL}/api/v1/freebuff/session`, {
				headers: { Authorization: `Bearer ${authToken}` },
			});
			if (!check.ok) return;
			const live = (await check.json()) as { instanceId?: string };
			if (live?.instanceId !== owned.instanceId) return;
			await fetch(`${CODEBUFF_BASE_URL}/api/v1/freebuff/session`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${authToken}` },
			});
		} catch {
			// The server-side sweep is the backstop.
		}
	}
}

function describeRateLimit(body: Record<string, unknown> | undefined): string {
	const rl = (body?.rateLimit ?? body) as Record<string, unknown> | undefined;
	const parts: string[] = [];
	if (typeof rl?.limit === "number") {
		const used = typeof rl.recentCount === "number" ? rl.recentCount : undefined;
		parts.push(`${used ?? "?"} of ${rl.limit} sessions used`);
	}
	if (typeof rl?.resetAt === "string") {
		parts.push(`resets ${new Date(rl.resetAt).toLocaleString()}`);
	}
	if (parts.length === 0 && typeof body?.message === "string") parts.push(body.message);
	parts.push("referrals earn extra sessions (see the freebuff CLI /refer-friends)");
	return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Free-mode agent runs (every completion must reference an allowlisted agent)
// ---------------------------------------------------------------------------

class FreebuffRunManager {
	private runs = new Map<string, string>();
	private starting = new Map<string, Promise<string>>();

	async ensureRunId(modelId: string, token: string): Promise<string> {
		const existing = this.runs.get(modelId);
		if (existing) return existing;
		let pending = this.starting.get(modelId);
		if (!pending) {
			pending = this.startAgentRun(modelId, token)
				.then((runId) => {
					this.runs.set(modelId, runId);
					return runId;
				})
				.finally(() => this.starting.delete(modelId));
			this.starting.set(modelId, pending);
		}
		return pending;
	}

	private async startAgentRun(modelId: string, token: string): Promise<string> {
		const agentId = FREEBUFF_AGENT_BY_MODEL[modelId] ?? "base2-free";
		const res = await fetch(`${CODEBUFF_BASE_URL}/api/v1/agent-runs`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
		});
		if (!res.ok) {
			throw new Error(
				`Freebuff agent-runs START failed for ${agentId}: ${res.status} ${(await res.text()).slice(0, 300)}`,
			);
		}
		const data = (await res.json()) as { runId?: string };
		if (!data.runId) throw new Error("Freebuff agent-runs START returned no runId");
		return data.runId;
	}

	async finishAll(token?: string): Promise<void> {
		const authToken = token ?? resolveFreebuffToken();
		if (!authToken || this.runs.size === 0) return;
		const runIds = [...this.runs.values()];
		this.runs.clear();
		await Promise.all(
			runIds.map(async (runId) => {
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
					// best-effort; stale runs are cleaned up server-side
				}
			}),
		);
	}
}

// ---------------------------------------------------------------------------
// Payload enrichment
// ---------------------------------------------------------------------------

/**
 * Ensure the first system message opens with the canonical Buffy marker.
 * Free-mode requests are rejected server-side otherwise. pi's own system
 * prompt follows the marker unchanged, so the model reads the Freebuff
 * identity first, then pi's full instructions.
 */
function ensureBuffySystemMarker(messages: unknown): unknown {
	if (!Array.isArray(messages)) return messages;

	const isMarked = (text: string): boolean =>
		text.trimStart().startsWith(FREEBUFF_SYSTEM_MARKER);

	const idx = messages.findIndex(
		(m) =>
			m &&
			typeof m === "object" &&
			((m as { role?: unknown }).role === "system" ||
				(m as { role?: unknown }).role === "developer"),
	);

	if (idx === -1) {
		return [{ role: "system", content: FREEBUFF_SYSTEM_MARKER }, ...messages];
	}

	const first = messages[idx] as Record<string, unknown>;
	const content = first.content;

	if (typeof content === "string") {
		if (isMarked(content)) return messages;
		const next = [...messages];
		next[idx] = { ...first, content: `${FREEBUFF_SYSTEM_MARKER}\n\n${content}` };
		return next;
	}

	if (Array.isArray(content)) {
		const firstText = content.find(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		) as { text: string } | undefined;
		if (firstText && isMarked(firstText.text)) return messages;
		const next = [...messages];
		next[idx] = {
			...first,
			content: [
				{ type: "text", text: `${FREEBUFF_SYSTEM_MARKER}\n\n` },
				...content,
			],
		};
		return next;
	}

	// Unknown content shape — leave the message untouched rather than break it.
	return messages;
}

/**
 * GLM 5.2 rejects replayed assistant reasoning fields (see the codebuff
 * provider's notes); keep only normal chat content/tool calls in history.
 */
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
			delete next.reasoning;
			delete next.reasoning_content;
			delete next.reasoning_text;
			delete next.reasoning_details;
			if (next.content == null && Array.isArray(next.tool_calls)) {
				next.content = "";
			}
			return next;
		}),
	};
}

// ---------------------------------------------------------------------------
// Session status display (footer status line + /freebuff details card)
// ---------------------------------------------------------------------------

function fmtCountdown(ms: number): string {
	if (ms <= 0) return "expired";
	const totalMin = Math.ceil(ms / 60_000);
	if (totalMin < 60) return `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Quota counters can be fractional (sessions are weighted); trim ".0". */
function fmtCount(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function sessionDetailLines(d: FreebuffSessionDetails, modelId?: string): string[] {
	const lines: string[] = [];
	const active = d.status === "active";
	lines.push(
		`Status:        ${active ? `active — ${d.model ?? "unknown model"}` : (d.status ?? "none")}`,
	);
	if (active && d.expiresAt) {
		const remaining = Date.parse(d.expiresAt) - Date.now();
		lines.push(
			`Time left:     ${fmtCountdown(remaining)} (expires ${new Date(d.expiresAt).toLocaleTimeString()})`,
		);
	}
	if (d.accessTier) lines.push(`Access tier:   ${d.accessTier}`);
	const q = pickQuota(d, modelId);
	if (q && typeof q.limit === "number") {
		const used = typeof q.recentCount === "number" ? q.recentCount : 0;
		const left = Math.max(0, q.limit - used);
		lines.push(
			`Sessions:      ${fmtCount(used)}/${fmtCount(q.limit)} used today (${fmtCount(left)} left)`,
		);
		if (q.resetAt) {
			lines.push(`Quota resets:  ${new Date(q.resetAt).toLocaleString()}`);
		}
		const eb = q.entitlementBreakdown;
		if (eb) {
			lines.push(
				`Entitlements:  base ${eb.base ?? 0} · referral +${eb.referral ?? 0} · streak +${eb.streak ?? 0}`,
			);
		}
	}
	if (active && d.instanceId) {
		lines.push(`Instance:      ${d.instanceId.slice(0, 8)}…`);
	}
	if (!active) {
		lines.push("", "Send any request on a freebuff model to claim a 1-hour slot.");
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	seedAuthFromManicode();

	const sessions = new FreebuffSessionManager();
	const runs = new FreebuffRunManager();
	const clientId = crypto.randomUUID();
	const traceSessionId = crypto.randomUUID();

	// -- Footer status line ("freebuff: 42m left · 3.4/6 sessions left") ------

	const STATUS_KEY = "freebuff";
	const DETAILS_REFRESH_MS = 60_000;

	let lastUi: ExtensionContext["ui"] | undefined;
	let activeProvider: string | undefined;
	let activeModelId: string | undefined;
	let detailsCache: FreebuffSessionDetails | undefined;
	let detailsFetchedAt = 0;
	let refreshInFlight: Promise<void> | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;

	function updateStatus(): void {
		const ui = lastUi;
		if (!ui) return;
		if (activeProvider !== "freebuff") {
			ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const snap = sessions.snapshot();
		const d = detailsCache;
		// Prefer the server's truth (≤60s old); fall back to the local admission
		// (fresh after a request), then to stale cached details.
		const localAdmission =
			snap.admission && snap.admission.expiresAtMs - Date.now() > 0
				? snap.admission
				: undefined;
		const expiresMs =
			d?.status === "active" && d.expiresAt
				? Date.parse(d.expiresAt)
				: (localAdmission?.expiresAtMs ??
					(d?.expiresAt ? Date.parse(d.expiresAt) : undefined));
		const parts: string[] = [];
		if (expiresMs && Number.isFinite(expiresMs)) {
			const remaining = expiresMs - Date.now();
			parts.push(remaining > 0 ? `${fmtCountdown(remaining)} left` : "session expired");
		} else {
			parts.push("no session");
		}
		const q = pickQuota(d, activeModelId);
		if (typeof q?.limit === "number" && typeof q.recentCount === "number") {
			parts.push(
				`${fmtCount(Math.max(0, q.limit - q.recentCount))}/${fmtCount(q.limit)} sessions left`,
			);
		}
		ui.setStatus(
			STATUS_KEY,
			parts.length > 0 ? `freebuff: ${parts.join(" · ")}` : "freebuff: no session",
		);
	}

	/** Refresh live details (quota + slot) from the backend; throttled. */
	function refreshDetails(force = false): void {
		if (!force && Date.now() - detailsFetchedAt < DETAILS_REFRESH_MS) return;
		if (refreshInFlight) return;
		const token = resolveFreebuffToken();
		if (!token) return;
		detailsFetchedAt = Date.now();
		refreshInFlight = (async () => {
			try {
				const d = await fetchFreebuffSessionDetails(token);
				if (d) {
					detailsCache = d;
					updateStatus();
				}
			} finally {
				refreshInFlight = undefined;
			}
		})();
	}

	/** Called after a successful admission so the status line updates instantly. */
	function noteAdmission(): void {
		const snap = sessions.snapshot();
		if (snap.details) detailsCache = snap.details;
		updateStatus();
	}

	function ensureStatusTimer(): void {
		if (statusTimer) return;
		statusTimer = setInterval(() => {
			if (activeProvider !== "freebuff") return;
			updateStatus();
			refreshDetails();
		}, 30_000);
		statusTimer.unref?.();
	}

	async function enrichPayload(
		payload: Record<string, unknown>,
		modelId: string,
		explicitToken?: string,
	): Promise<Record<string, unknown>> {
		const token = resolveFreebuffToken(explicitToken);
		if (!token) {
			throw new Error(
				"Freebuff auth token missing — run /login freebuff, set CODEBUFF_API_KEY, " +
					"or sign into the freebuff CLI (its credential is picked up automatically).",
			);
		}
		const [instanceId, runId] = await Promise.all([
			sessions.ensureInstanceId(modelId, token),
			runs.ensureRunId(modelId, token),
		]);
		noteAdmission();
		const existingMeta =
			(payload.codebuff_metadata as Record<string, unknown> | undefined) ?? {};
		let next: Record<string, unknown> = {
			...payload,
			messages: ensureBuffySystemMarker(payload.messages),
			codebuff_metadata: {
				...existingMeta,
				freebuff_instance_id: instanceId,
				run_id: runId,
				client_id: clientId,
				trace_session_id: traceSessionId,
				cost_mode: "free",
			},
			provider: {
				...((payload.provider as Record<string, unknown> | undefined) ?? {}),
				allow_fallbacks: true,
			},
			usage: { include: true },
		};
		if (modelId === "z-ai/glm-5.2") {
			next = sanitizeGlm52Payload(next);
		}
		return next;
	}

	/** Single streaming attempt with freebuff payload enrichment. */
	function openaiStreamOnce(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) {
		// pi only routes models whose api matches the registered "openai-completions"
		// here, so the narrowed call is safe.
		return streamSimpleOpenAICompletions(
			model as Model<"openai-completions">,
			context,
			{
			...options,
			onPayload: async (payload, payloadModel) => {
				let next = await enrichPayload(
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
				return next;
			},
			onResponse: (response, responseModel) => {
				// 409 session_superseded / 428 waiting_room_required: the slot died
				// (expired, or the Freebuff CLI re-joined). Drop the cached admission
				// so the next request re-admits instead of failing again.
				if (response.status === 409 || response.status === 428) {
					sessions.invalidate();
					detailsCache = undefined;
					updateStatus();
				}
				return options?.onResponse?.(response, responseModel);
			},
			},
		);
	}

	/**
	 * True when a terminal stream error means "the account's slot is gone" and
	 * re-admission is the cure: 428 waiting_room_required (slot released or
	 * swept) and 409 session_superseded (the CLI or another pi re-admitted).
	 */
	function isSessionSlotError(event: AssistantMessageEvent): boolean {
		if (event.type !== "error") return false;
		const msg = event.error.errorMessage ?? "";
		return /waiting_room_required|session_superseded|\b428\b|\b409\b/.test(msg);
	}

	/**
	 * Stream with one transparent re-admission retry. Slot-loss errors arrive
	 * as the stream's FIRST event — before any content — so the attempt can be
	 * safely discarded and replayed after re-admitting, instead of failing the
	 * user's turn. Mid-stream failures (after content started) are never
	 * retried; that would duplicate output.
	 */
	function streamWithSessionRetry(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		retriesLeft: number,
	) {
		const inner = openaiStreamOnce(model, context, options);
		if (retriesLeft <= 0) return inner;
		const out = createAssistantMessageEventStream();
		(async () => {
			let isFirstEvent = true;
			for await (const event of inner) {
				if (isFirstEvent) {
					isFirstEvent = false;
					if (isSessionSlotError(event)) {
						sessions.invalidate();
						detailsCache = undefined;
						updateStatus();
						const retry = streamWithSessionRetry(
							model,
							context,
							options,
							retriesLeft - 1,
						);
						for await (const retryEvent of retry) {
							out.push(retryEvent);
						}
						out.end();
						return;
					}
				}
				out.push(event);
			}
			out.end();
		})().catch((err: unknown) => {
			// Wrapper-level failure (the inner stream reports provider errors as
			// events, so this should never happen): synthesize a terminal error
			// event so consumers awaiting .result() never hang.
			out.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: `Freebuff stream wrapper failed: ${err instanceof Error ? err.message : String(err)}`,
					timestamp: Date.now(),
				} as AssistantMessage,
			});
			out.end();
		});
		return out;
	}

	function streamSimpleFreebuff(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) {
		return streamWithSessionRetry(model, context, options, 1);
	}

	pi.registerProvider("freebuff", {
		name: "Freebuff",
		baseUrl: `${CODEBUFF_BASE_URL}/api/v1`,
		apiKey: "CODEBUFF_API_KEY",
		api: "openai-completions",
		authHeader: true,
		streamSimple: streamSimpleFreebuff,
		headers: {
			"user-agent": CODEBUFF_USER_AGENT,
		},
		models: [
			{
				id: "deepseek/deepseek-v4-flash",
				// Matches the CLI picker label: the wire id is undated and
				// auto-updates; "07/31" marks the re-post-trained GA build.
				name: "DeepSeek V4 Flash 07/31 (Freebuff)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
				compat: {
					// DeepSeek-direct route: native `thinking` toggle, reasoning_content
					// in the stream. No reasoning_effort (the model self-manages).
					thinkingFormat: "deepseek",
					supportsReasoningEffort: false,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "mimo/mimo-v2.5",
				name: "MiMo 2.5 (Freebuff)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 131072,
				compat: {
					// Accepts both `thinking` and `reasoning` objects (verified live);
					// emits reasoning_content like DeepSeek.
					thinkingFormat: "deepseek",
					supportsReasoningEffort: false,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "deepseek/deepseek-v4-pro",
				name: "DeepSeek V4 Pro (Freebuff Premium)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
				compat: {
					thinkingFormat: "deepseek",
					supportsReasoningEffort: false,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "minimax/minimax-m3",
				name: "MiniMax M3 (Freebuff Premium)",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: null,
					medium: null,
					high: null,
					xhigh: null,
					max: null,
				},
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 524288,
				maxTokens: 131072,
				compat: {
					// Never send reasoning params (all levels map to null); thinking
					// blocks still parse/replay if the route emits them.
					thinkingFormat: "openrouter",
					supportsReasoningEffort: false,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "openai/gpt-5.6-luna",
				name: "GPT-5.6 Luna (Freebuff Premium)",
				reasoning: true,
				thinkingLevelMap: {
					off: "high",
					minimal: "high",
					low: "high",
					medium: "high",
					high: "high",
					xhigh: "high",
					max: "high",
				},
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 131072,
				compat: {
					// The freebuff agent pins reasoning_effort: high and the server
					// re-pins it for free traffic — mirror that exactly.
					thinkingFormat: "openai",
					supportsReasoningEffort: true,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "z-ai/glm-5.2",
				name: "GLM 5.2 (Freebuff Referral)",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: null,
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "xhigh",
				},
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 131072,
				compat: {
					thinkingFormat: "openrouter",
					supportsReasoningEffort: true,
					supportsDeveloperRole: false,
				},
			},
			{
				id: "anthropic/claude-fable-5",
				name: "Claude Fable 5 (Freebuff Limited Offer)",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "high",
					max: "high",
				},
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
				compat: {
					thinkingFormat: "openrouter",
					supportsReasoningEffort: true,
					supportsDeveloperRole: false,
				},
			},
		],
		oauth: {
			name: "Freebuff",
			login: loginFreebuff,
			refreshToken: async (cred) => cred,
			getApiKey: (cred) => cred.access,
		},
	});

	// -- Status-line lifecycle ------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		lastUi = ctx.hasUI ? ctx.ui : undefined;
		activeProvider = ctx.model?.provider;
		activeModelId = ctx.model?.id;
		ensureStatusTimer();
		if (activeProvider === "freebuff") refreshDetails(true);
		updateStatus();
	});

	pi.on("model_select", (event, ctx) => {
		lastUi = ctx.hasUI ? ctx.ui : undefined;
		activeProvider = event.model.provider;
		activeModelId = event.model.id;
		if (activeProvider === "freebuff") refreshDetails();
		updateStatus();
	});

	pi.on("turn_end", (_event, ctx) => {
		lastUi = ctx.hasUI ? ctx.ui : undefined;
		if (activeProvider === "freebuff") refreshDetails();
	});

	// -- /freebuff ------------------------------------------------------------

	// Renders the details card as a custom session entry (never sent to the LLM).
	pi.registerEntryRenderer("freebuff-status", (entry, _options, theme) => {
		const lines =
			(entry.data as { lines?: string[] } | undefined)?.lines ?? [];
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(
			new Text(theme.fg("customMessageLabel", "\x1b[1m[freebuff]\x1b[22m"), 0, 0),
		);
		for (const line of lines) {
			box.addChild(new Text(theme.fg("customMessageText", line || " "), 0, 0));
		}
		return box;
	});

	pi.registerCommand("freebuff", {
		description: "Show Freebuff session status (time left, daily quota, access tier)",
		handler: async (_args, ctx) => {
			const token = resolveFreebuffToken();
			if (!token) {
				ctx.ui.notify("Freebuff: no auth token — run /login freebuff", "warning");
				return;
			}
			const d = await fetchFreebuffSessionDetails(token);
			if (!d) {
				ctx.ui.notify("Freebuff: couldn't fetch session details", "error");
				return;
			}
			detailsCache = d;
			detailsFetchedAt = Date.now();
			lastUi = ctx.hasUI ? ctx.ui : lastUi;
			activeProvider = ctx.model?.provider ?? activeProvider;
			activeModelId = ctx.model?.id ?? activeModelId;
			updateStatus();
			pi.appendEntry("freebuff-status", {
				lines: sessionDetailLines(d, activeModelId),
			});
		},
	});

	pi.on("session_shutdown", async () => {
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
		lastUi?.setStatus(STATUS_KEY, undefined);
		await Promise.all([runs.finishAll(), sessions.release()]);
	});
}
