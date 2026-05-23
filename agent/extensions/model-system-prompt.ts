import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type ModelInfo = {
	id?: string;
};

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

function promptFileName(segment: string): string {
	return `SYSTEM.${segment.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`;
}

function modelPromptPath(model: ModelInfo): string | undefined {
	const agentDir = getAgentDir();
	const id = model.id?.trim();
	if (!id) return undefined;
	return join(agentDir, promptFileName(id));
}

function readSystemPrompt(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8").trimStart();
	} catch {
		return undefined;
	}
}

function createSystemPrompt(path: string, systemPrompt: string): boolean {
	try {
		writeFileSync(path, systemPrompt, { encoding: "utf8", flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

function announceSystemPrompt(ctx: unknown, message: string) {
	const ui = ctx as { hasUI?: boolean; ui?: { notify?: (message: string, kind?: string) => void } };
	if (ui.hasUI && ui.ui?.notify) {
		ui.ui.notify(message, "info");
		return;
	}
	console.error(message);
}

function isSubagentChild(): boolean {
	return process.env[SUBAGENT_CHILD_ENV] === "1";
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (isSubagentChild()) return;

		const model = (ctx as { model?: ModelInfo }).model;
		if (!model) return;

		const path = modelPromptPath(model);
		if (!path) return;

		const existingPrompt = readSystemPrompt(path);
		if (existingPrompt !== undefined) {
			announceSystemPrompt(ctx, `Using system prompt: ${path}`);
			return { systemPrompt: existingPrompt };
		}

		const created = createSystemPrompt(path, "");
		if (created) {
			announceSystemPrompt(ctx, `Created and using empty system prompt: ${path}`);
			return { systemPrompt: "" };
		}

		const promptAfterCreateRace = readSystemPrompt(path);
		if (promptAfterCreateRace !== undefined) {
			announceSystemPrompt(ctx, `Using system prompt: ${path}`);
			return { systemPrompt: promptAfterCreateRace };
		}

		announceSystemPrompt(
			ctx,
			`Using empty system prompt; could not create model prompt file: ${path}`,
		);
		return { systemPrompt: "" };
	});
}
