import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VISION_PROVIDER = "openrouter";
const VISION_MODEL = "google/gemini-3.6-flash";
const FALLBACK_MODEL_IDS = new Set([
	"deepseek/deepseek-v4-flash-0731",
	"deepseek/deepseek-v4-flash",
]);
const IMAGE_READ_TOOLS = new Set(["read", "read-image"]);

function needsImageFallback(provider: string, modelId: string): boolean {
	return FALLBACK_MODEL_IDS.has(`${provider}/${modelId}`) || FALLBACK_MODEL_IDS.has(modelId);
}

function assistantText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (!IMAGE_READ_TOOLS.has(event.toolName) || event.isError || !ctx.model) return;
		if (!needsImageFallback(ctx.model.provider, ctx.model.id)) return;

		const images = event.content.filter((block) => block.type === "image");
		if (images.length === 0) return;

		const visionModel = ctx.modelRegistry.find(VISION_PROVIDER, VISION_MODEL);
		if (!visionModel) {
			return {
				content: [{ type: "text", text: `Image analysis unavailable: ${VISION_PROVIDER}/${VISION_MODEL} is not registered.` }],
				isError: true,
			};
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(visionModel);
		if (!auth.ok) {
			return {
				content: [{ type: "text", text: `Image analysis unavailable: ${auth.error}` }],
				isError: true,
			};
		}

		let response;
		try {
			response = await ctx.modelRegistry.complete(
				visionModel,
				{
					systemPrompt:
						"You are a careful read-only image analyzer. Describe only visible evidence. Return concise Markdown that gives another model all useful visual content, including exact text, values, layout, and uncertainty when relevant.",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "Analyze the attached image. Provide a faithful description suitable as the result of a file read." },
								...images,
							],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 4_000, reasoning: "xhigh", signal: ctx.signal },
			);
		} catch (error) {
			return {
				content: [{ type: "text", text: `Image analysis failed: ${error instanceof Error ? error.message : String(error)}` }],
				isError: true,
			};
		}

		const description = assistantText(response.content);
		if (response.stopReason === "error" || response.stopReason === "aborted" || !description) {
			return {
				content: [{ type: "text", text: `Image analysis failed: ${response.errorMessage ?? (response.stopReason === "aborted" ? "request aborted" : "the vision model returned no description")}.` }],
				isError: true,
				usage: response.usage,
			};
		}

		return {
			content: [
				{
					type: "text",
					text: `Read image file via ${VISION_PROVIDER}/${VISION_MODEL}\n\n${description}`,
				},
			],
			usage: response.usage,
		};
	});
}

export { assistantText, needsImageFallback };
