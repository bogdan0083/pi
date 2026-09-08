/**
 * Interrupting the parent must not drop extension-injected custom messages.
 *
 * Background subagent completions arrive via sendCustomMessage() with
 * deliverAs "followUp" while the parent streams. They queue directly in the
 * agent follow-up queue (not in the user-text tracking arrays), so the old
 * clearQueue() — which wiped all agent queues — silently discarded them on
 * interrupt before any transcript entry was persisted.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Mock stream that mimics AssistantMessageEventStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, stopReason: "stop" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("AgentSession clearQueue preserves extension custom messages", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-clear-queue-custom-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let calls = 0;
		let abortSignal: AbortSignal | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			// First turn blocks until aborted (the interrupted parent turn);
			// later turns (notification delivery) complete immediately.
			streamFn: (_model, _context, options) => {
				calls++;
				const firstTurn = calls === 1;
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (firstTurn) {
						const checkAbort = () => {
							if (abortSignal?.aborted) {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							} else {
								setTimeout(checkAbort, 5);
							}
						};
						checkAbort();
					} else {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ack") });
					}
				});
				return stream;
			},
		});

		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	function customEntries() {
		return sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "subagents");
	}

	it("keeps queued custom follow-ups across clearQueue and persists them after abort", async () => {
		await createSession();

		const promptPromise = session.prompt("Parent task");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		// Ordinary user follow-up queued while streaming.
		await session.followUp("user queued text");

		// Three background completions land while streaming, as the extension sends them.
		for (let i = 1; i <= 3; i++) {
			await session.sendCustomMessage(
				{ customType: "subagents", content: `completed bg-${i}`, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// Interrupt: user text is restored to the editor, customs must survive.
		const restored = session.clearQueue();
		expect(restored).toEqual({ steering: [], followUp: ["user queued text"] });
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// Abort settles the parent turn; the continuation delivers the survivors.
		await session.abort();
		await promptPromise;

		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(customEntries()).toHaveLength(3);
	}, 15000);

	it("still returns only user text when no custom messages are queued", async () => {
		await createSession();

		const promptPromise = session.prompt("Parent task");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		await session.followUp("user queued text");
		const restored = session.clearQueue();
		expect(restored).toEqual({ steering: [], followUp: ["user queued text"] });
		expect(session.agent.hasQueuedMessages()).toBe(false);

		await session.abort();
		await promptPromise;
		expect(customEntries()).toHaveLength(0);
	}, 15000);
});
