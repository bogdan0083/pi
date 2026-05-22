import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const KILO_GATEWAY_BASE_URL = "https://api.kilo.ai/api/gateway/v1";
const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
const KILO_AUTH_FILE = join(homedir(), ".local", "share", "kilo", "auth.json");
const PI_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const KILO_GATEWAY_HEADERS = {
	"HTTP-Referer": "https://kilocode.ai",
	"X-Title": "Kilo Code",
	"User-Agent": "Kilo-Code/7.3.1",
} as const;

interface KiloAuthCredential {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
}

interface KiloGatewayModel {
	id: string;
	name: string;
	context_length?: number;
	supported_parameters?: string[];
	architecture?: { input_modalities?: string[] };
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

interface KiloModelsResponse {
	data: KiloGatewayModel[];
}

const FALLBACK_MODELS: ProviderModelConfig[] = [
	{
		id: "anthropic/claude-opus-4.7",
		name: "Claude Opus 4.7 (Kilo)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6 (Kilo)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "openai/gpt-5.5",
		name: "GPT 5.5 (Kilo)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
	{
		id: "kilo-auto/balanced",
		name: "Auto Balanced (Kilo)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.325, output: 1.95, cacheRead: 0.0325, cacheWrite: 0.40625 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
];

let fetchShimInstalled = false;

function resolveCurlPath(): string {
	const candidates = [
		process.env.KILO_CURL_PATH,
		"/usr/bin/curl",
		"/opt/homebrew/bin/curl",
		"curl",
	].filter(Boolean) as string[];
	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ["--version"], { stdio: "ignore" });
			return candidate;
		} catch {
			// try next candidate
		}
	}
	throw new Error(
		"curl is required for the Kilo Gateway provider (Node fetch is blocked by api.kilo.ai).",
	);
}

function headersToArgs(headers?: HeadersInit): string[] {
	const args: string[] = [];
	if (!headers) return args;
	const entries =
		headers instanceof Headers
			? Array.from(headers.entries())
			: Array.isArray(headers)
				? headers
				: Object.entries(headers);
	for (const [key, value] of entries) {
		args.push("-H", `${key}: ${value}`);
	}
	return args;
}

function parseCurlResponseHeaders(rawHeaders: string): {
	status: number;
	headers: Headers;
} {
	const lines = rawHeaders.replace(/\r\n/g, "\n").trim().split("\n");
	const statusLine = lines[0] ?? "";
	const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
	const status = statusMatch
		? Number.parseInt(statusMatch[1] ?? "200", 10)
		: 200;
	const headers = new Headers();
	for (const line of lines.slice(1)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
	}
	return { status, headers };
}

async function curlFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const curlPath = resolveCurlPath();
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	if (init?.headers) {
		new Headers(init.headers).forEach((value, key) => headers.set(key, value));
	}

	const args = [
		"-sS",
		"-N",
		"--http1.1",
		"-X",
		method,
		"-D",
		"/dev/stderr",
		...headersToArgs(headers),
		url,
	];

	if (init?.body != null) {
		const body =
			typeof init.body === "string"
				? init.body
				: init.body instanceof URLSearchParams
					? init.body.toString()
					: await new Response(init.body).text();
		args.push("--data-binary", body);
	}

	return await new Promise<Response>((resolve, reject) => {
		const child = spawn(curlPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let headerBlock = "";
		let headersParsed = false;
		let statusCode = 200;
		let responseHeaders = new Headers();
		const passthrough = new Readable({ read() {} });

		child.stderr.on("data", (chunk: Buffer) => {
			if (headersParsed) return;
			headerBlock += chunk.toString("utf8");
			const marker = headerBlock.includes("\r\n\r\n")
				? "\r\n\r\n"
				: headerBlock.includes("\n\n")
					? "\n\n"
					: "";
			if (!marker) return;

			const headerEnd = headerBlock.indexOf(marker);
			const parsed = parseCurlResponseHeaders(headerBlock.slice(0, headerEnd));
			statusCode = parsed.status;
			responseHeaders = parsed.headers;
			headersParsed = true;
			resolve(
				new Response(Readable.toWeb(passthrough) as ReadableStream, {
					status: statusCode,
					headers: responseHeaders,
				}),
			);
		});

		child.stdout.on("data", (chunk: Buffer) => {
			passthrough.push(chunk);
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (!headersParsed) {
				if (code === 0) {
					resolve(new Response("", { status: statusCode }));
				} else {
					reject(
						new Error(
							`curl failed (${code ?? "unknown"}): ${headerBlock.trim() || "no stderr"}`,
						),
					);
				}
				return;
			}

			if (code !== 0) {
				passthrough.destroy(
					new Error(`curl failed (${code ?? "unknown"})`),
				);
				return;
			}
			passthrough.push(null);
		});
	});
}

function installKiloFetchShim(): void {
	if (fetchShimInstalled) return;
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url.includes("api.kilo.ai")) {
			return curlFetch(input, init);
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	fetchShimInstalled = true;
}

function readKiloCredential(): KiloAuthCredential | undefined {
	try {
		const parsed = JSON.parse(readFileSync(KILO_AUTH_FILE, "utf8")) as Record<
			string,
			KiloAuthCredential
		>;
		return parsed.kilo;
	} catch {
		return undefined;
	}
}

function readPiKiloCredential(): KiloAuthCredential | undefined {
	try {
		const parsed = JSON.parse(readFileSync(PI_AUTH_FILE, "utf8")) as Record<
			string,
			KiloAuthCredential
		>;
		return parsed.kilo;
	} catch {
		return undefined;
	}
}

function toOAuthCredentials(cred: KiloAuthCredential): OAuthCredentials {
	const access = cred.access;
	if (typeof access !== "string" || access.length === 0) {
		throw new Error("Kilo credential is missing access token.");
	}
	return {
		access,
		refresh: cred.refresh ?? access,
		expires:
			typeof cred.expires === "number"
				? cred.expires
				: Date.now() + 365 * 24 * 60 * 60 * 1000,
	};
}

function syncKiloAuthToPi(): void {
	const kilo = readKiloCredential();
	if (!kilo?.access) return;

	try {
		let piAuth: Record<string, KiloAuthCredential> = {};
		try {
			piAuth = JSON.parse(readFileSync(PI_AUTH_FILE, "utf8")) as Record<
				string,
				KiloAuthCredential
			>;
		} catch {
			// auth.json may not exist yet
		}

		const existing = piAuth.kilo;
		if (existing?.access === kilo.access) return;

		piAuth.kilo = {
			type: "oauth",
			access: kilo.access,
			refresh: kilo.refresh ?? kilo.access,
			expires:
				typeof kilo.expires === "number"
					? kilo.expires
					: Date.now() + 365 * 24 * 60 * 60 * 1000,
		};
		writeFileSync(PI_AUTH_FILE, `${JSON.stringify(piAuth, null, 2)}\n`);
	} catch {
		// best-effort sync; pi /login kilo still works
	}
}

function resolveKiloCredentials(): OAuthCredentials | undefined {
	const piCred = readPiKiloCredential();
	if (piCred?.access) {
		try {
			return toOAuthCredentials(piCred);
		} catch {
			// fall through to kilo auth file
		}
	}

	const kiloCred = readKiloCredential();
	if (!kiloCred?.access) return undefined;
	return toOAuthCredentials(kiloCred);
}

function perMillionTokens(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return 0;
	return parsed * 1_000_000;
}

function mapKiloModel(model: KiloGatewayModel): ProviderModelConfig {
	const supported = new Set(model.supported_parameters ?? []);
	const modalities = model.architecture?.input_modalities ?? ["text"];
	const input: ("text" | "image")[] = [];
	if (modalities.includes("text")) input.push("text");
	if (
		modalities.includes("image") ||
		modalities.includes("file") ||
		modalities.includes("pdf")
	) {
		input.push("image");
	}
	if (input.length === 0) input.push("text");

	return {
		id: model.id,
		name: `${model.name} (Kilo)`,
		reasoning:
			supported.has("reasoning") || supported.has("include_reasoning"),
		input,
		cost: {
			input: perMillionTokens(model.pricing?.prompt),
			output: perMillionTokens(model.pricing?.completion),
			cacheRead: perMillionTokens(model.pricing?.input_cache_read),
			cacheWrite: perMillionTokens(model.pricing?.input_cache_write),
		},
		contextWindow:
			model.context_length ??
			model.top_provider?.context_length ??
			200_000,
		maxTokens: model.top_provider?.max_completion_tokens ?? 32_000,
	};
}

function fetchKiloModelsWithCurl(token: string): ProviderModelConfig[] {
	const curlPath = resolveCurlPath();
	const output = execFileSync(
		curlPath,
		[
			"-sS",
			"-H",
			`Authorization: Bearer ${token}`,
			...headersToArgs(KILO_GATEWAY_HEADERS),
			KILO_MODELS_URL,
		],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	const data = JSON.parse(output) as KiloModelsResponse;
	return data.data.map(mapKiloModel);
}

async function runKiloAuthLogin(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("kilo", ["auth", "login", "-p", "kilo"], {
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`kilo auth login failed (exit ${code ?? "unknown"})`));
		});
	});
}

async function loginKilo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const existing = resolveKiloCredentials();
	if (existing) return existing;

	callbacks.onAuth({
		instructions:
			"Complete Kilo login in your browser. If nothing opens, run `kilo auth login -p kilo` in another terminal.",
	});

	await runKiloAuthLogin();
	syncKiloAuthToPi();

	const cred = resolveKiloCredentials();
	if (!cred) {
		throw new Error(
			"Kilo login finished but no token was found in ~/.local/share/kilo/auth.json.",
		);
	}
	return cred;
}

export default async function (pi: ExtensionAPI) {
	installKiloFetchShim();
	syncKiloAuthToPi();

	let models = FALLBACK_MODELS;
	const cred = resolveKiloCredentials();
	if (cred?.access) {
		try {
			models = fetchKiloModelsWithCurl(cred.access);
		} catch {
			models = FALLBACK_MODELS;
		}
	}

	pi.registerProvider("kilo", {
		name: "Kilo Gateway",
		baseUrl: KILO_GATEWAY_BASE_URL,
		apiKey: "KILO_API_KEY",
		api: "openai-completions",
		authHeader: true,
		headers: KILO_GATEWAY_HEADERS,
		models,
		oauth: {
			name: "Kilo Gateway",
			login: loginKilo,
			refreshToken: async (credentials) => {
				syncKiloAuthToPi();
				return resolveKiloCredentials() ?? credentials;
			},
			getApiKey: (credentials) => credentials.access,
		},
	});
}
