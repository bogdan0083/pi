import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const Question = Type.Object({
	id: Type.String({ description: "Stable, short identifier used to associate the answer with this question." }),
	question: Type.String({ description: "The question shown to the user." }),
	options: Type.Array(Type.String(), {
		description: "Suggested answers shown as selectable options. Use concise, mutually exclusive labels.",
		minItems: 1,
		maxItems: 12,
	}),
	allowCustom: Type.Optional(
		Type.Boolean({ description: "Allow the user to enter an answer not listed in options. Defaults to true." }),
	),
	customLabel: Type.Optional(
		Type.String({ description: "Label for the custom-answer option. Defaults to ‘Other (type an answer)…’." }),
	),
	placeholder: Type.Optional(Type.String({ description: "Placeholder shown when entering a custom answer." })),
});

const AskQuestionParams = Type.Object({
	questions: Type.Array(Question, {
		description: "One or more questions to present in order.",
		minItems: 1,
		maxItems: 10,
	}),
});

type Answer = {
	id: string;
	question: string;
	answer: string;
	custom: boolean;
};

type AskQuestionDetails = {
	answers: Answer[];
	cancelled: boolean;
	cancelledAt?: string;
};

const DEFAULT_CUSTOM_LABEL = "Other (type an answer)…";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user one or more questions interactively. Each question displays suggested answers and can allow a custom text answer. " +
			"Use this instead of guessing whenever requirements, intent, preferences, constraints, or conflicting details need clarification.",
		promptSnippet:
			"ask_question: Ask one or more interactive clarification questions with selectable suggested answers and optional custom input.",
		promptGuidelines: [
			"Use ask_question for non-trivial requests before acting, and whenever anything material is missing, unclear, or inconsistent.",
			"Offer concise, meaningful options; keep allowCustom enabled unless only the listed choices are valid.",
			"Group independent clarifications into one call instead of asking them one at a time across multiple turns.",
			"Do not guess an answer on the user's behalf.",
		],
		parameters: AskQuestionParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("ask_question requires an interactive Pi session; no user interface is available in this mode.");
			}

			const answers: Answer[] = [];
			const ids = new Set<string>();

			for (const item of params.questions) {
				const id = item.id.trim();
				const question = item.question.trim();
				const options = item.options.map((option) => option.trim()).filter(Boolean);
				if (!id) throw new Error("Every question must have a non-empty id.");
				if (ids.has(id)) throw new Error(`Question id must be unique: ${id}`);
				ids.add(id);
				if (!question) throw new Error(`Question ${id} has empty question text.`);
				if (options.length === 0) throw new Error(`Question ${id} must have at least one non-empty option.`);
				if (new Set(options).size !== options.length) throw new Error(`Question ${id} contains duplicate options.`);

				const allowCustom = item.allowCustom !== false;
				let customLabel = (item.customLabel ?? DEFAULT_CUSTOM_LABEL).trim() || DEFAULT_CUSTOM_LABEL;
				while (options.includes(customLabel)) customLabel = `${customLabel} `;
				const choices = allowCustom ? [...options, customLabel] : options;
				const title = params.questions.length > 1 ? `${question} (${answers.length + 1}/${params.questions.length})` : question;
				const selected = await ctx.ui.select(title, choices, { signal });

				if (selected === undefined) {
					const details: AskQuestionDetails = { answers, cancelled: true, cancelledAt: id };
					return {
						content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
						details,
					};
				}

				let answer = selected;
				let custom = false;
				if (allowCustom && selected === customLabel) {
					const entered = await ctx.ui.input(question, item.placeholder ?? "Type your answer", { signal });
					if (entered === undefined) {
						const details: AskQuestionDetails = { answers, cancelled: true, cancelledAt: id };
						return {
							content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
							details,
						};
					}
					answer = entered.trim();
					custom = true;
				}

				answers.push({ id, question, answer, custom });
			}

			const details: AskQuestionDetails = { answers, cancelled: false };
			return {
				content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
				details,
			};
		},
		renderCall(args, theme) {
			const count = args.questions.length;
			const preview = args.questions[0]?.question ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`ask_question (${count}) `)) + theme.fg("accent", preview),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as AskQuestionDetails | undefined;
			if (!details) return new Text(theme.fg("warning", "No answers returned"), 0, 0);
			const lines = details.answers.map((answer) => `${answer.question}: ${answer.answer}`);
			if (details.cancelled) lines.push(`Cancelled${details.cancelledAt ? ` at ${details.cancelledAt}` : ""}`);
			return new Text(
				`${theme.fg(details.cancelled ? "warning" : "success", details.cancelled ? "◼ Question dialog cancelled" : "✓ Questions answered")}\n${theme.fg("muted", lines.join("\n"))}`,
				0,
				0,
			);
		},
	});
}
