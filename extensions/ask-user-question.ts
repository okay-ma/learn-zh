import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	isOther?: boolean;
	isSubmit?: boolean;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'选项的显示标签。如果你推荐某个选项，把它放在第一位，并在标签末尾追加"(Recommended)"。',
	}),
	value: Type.Optional(
		Type.String({
			description: "为该选项返回的可选机器可读值。默认使用标签。",
		}),
	),
	description: Type.Optional(Type.String({ description: "显示在选项下方的可选额外说明。" })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "要问用户的单个问题。每次工具调用只问一个问题。",
	}),
	details: Type.Optional(
		Type.String({
			description: "显示在问题下方的可选额外上下文或说明。",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"可选的多选选项。省略或传入空数组即为自由文本输入。当提供选项时，用户总是能选择 Other 并输入自定义答案。",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "设为 true 以允许为一个问题选择多个答案。",
		}),
	),
});

function normalizeOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other" || option.label === "其他") ? "其他（自定义）" : "其他";
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
) {
	return {
		status,
		question,
		context,
		mode,
		answers,
		message,
	} as AskUserQuestionResultDetails;
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "用户取消了该问题";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function buildResult(question: string, context: string | undefined, mode: AskUserQuestionMode, answers: AskAnswer[]) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.trim().length > 0 ? `用户回答：${answer.label}` : "用户提交了空回复";
	} else if (mode === "single-select") {
		text = `用户选择：${formatAnswerForModel(answers[0])}`;
	} else {
		text = `用户选择：\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

async function askSingleChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer | null> {
	const otherLabel = getOtherLabel(options);
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
	];

	return ctx.ui.custom<AskAnswer | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer | null) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const editor = new Editor(tui, createEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			done({ type: "other", label: trimmed, value: trimmed });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isOther) {
					editMode = true;
					editor.setText("");
					refresh();
					return;
				}
				done({
					type: "option",
					label: selected.label,
					value: selected.value,
					index: selected.index!,
				});
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			// 缓存必须以 width 作为 key：终端 resize 时 pi-tui 会调用 requestRender()
			// 但不会调用 invalidate()，所以 render() 可能以新的 width 被重新进入。
			// 返回陈旧的更宽的行会触发 TUI 的宽度守卫并让进程崩溃。
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allOptions.length; i++) {
				const option = allOptions[i];
				const selected = i === optionIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
				const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
				add(`${prefix}${styled}`);
				if (option.description) {
					addWrapped(lines, theme.fg("muted", option.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " 写下你的自定义答案："));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter 提交 • Esc 返回"));
			} else {
				lines.push("");
				add(theme.fg("dim", " ↑↓ 导航 • Enter 选择 • Esc 取消"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

async function askMultiChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer[] | null> {
	const otherLabel = getOtherLabel(options);
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const submitItem: DisplayOption = { id: "submit", label: "提交", value: "__submit__", isSubmit: true };
	const allItems: DisplayOption[] = [
		...choiceItems,
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
		submitItem,
	];

	return ctx.ui.custom<AskAnswer[] | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer[] | null) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const selected = new Map<string, AskAnswer>();
		const editor = new Editor(tui, createEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			editMode = false;
			refresh();
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function toggleOption(item: DisplayOption) {
			if (selected.has(item.id)) {
				selected.delete(item.id);
			} else {
				selected.set(item.id, {
					type: "option",
					label: item.label,
					value: item.value,
					index: item.index!,
				});
			}
			refresh();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText(selected.get("other")?.label || "");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			const current = allItems[optionIndex];
			if (matchesKey(data, Key.space)) {
				if (current.isSubmit) return;
				if (current.isOther) {
					if (selected.has("other")) {
						selected.delete("other");
						refresh();
					} else {
						editMode = true;
						editor.setText("");
						refresh();
					}
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (current.isSubmit) {
					if (selected.size > 0) {
						done(sortAnswers(Array.from(selected.values())));
					}
					return;
				}
				if (current.isOther) {
					editMode = true;
					editor.setText(selected.get("other")?.label || "");
					refresh();
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			// 缓存必须以 width 作为 key：终端 resize 时 pi-tui 会调用 requestRender()
			// 但不会调用 invalidate()，所以 render() 可能以新的 width 被重新进入。
			// 返回陈旧的更宽的行会触发 TUI 的宽度守卫并让进程崩溃。
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allItems.length; i++) {
				const item = allItems[i];
				const isFocused = i === optionIndex;
				const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

				if (item.isSubmit) {
					const label = selected.size > 0 ? `✓ ${item.label}（已选 ${selected.size}）` : `○ ${item.label}`;
					const styled = isFocused
						? theme.fg("accent", label)
						: theme.fg(selected.size > 0 ? "success" : "dim", label);
					add(`${prefix}${styled}`);
					continue;
				}

				if (item.isOther) {
					const other = selected.get("other");
					const marker = other ? "[x]" : "[ ]";
					const suffix = other ? ` — ${other.label}` : "";
					const styled = isFocused
						? theme.fg("accent", `${marker} ${item.label}${suffix}`)
						: theme.fg(other ? "success" : "text", `${marker} ${item.label}${suffix}`);
					add(`${prefix}${styled}`);
					continue;
				}

				const checked = selected.has(item.id);
				const marker = checked ? "[x]" : "[ ]";
				const label = `${marker} ${item.index}. ${item.label}`;
				const styled = isFocused
					? theme.fg("accent", label)
					: theme.fg(checked ? "success" : "text", label);
				add(`${prefix}${styled}`);
				if (item.description) {
					addWrapped(lines, theme.fg("muted", item.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " 写下你的自定义答案："));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter 保存 • Esc 返回"));
			} else {
				lines.push("");
				if (selected.size === 0) {
					add(theme.fg("warning", " 提交前至少选择一个答案。"));
				}
				add(theme.fg("dim", " ↑↓ 导航 • Space 切换 • Enter 编辑/提交 • Esc 取消"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

// 共享 UI 互斥锁。ctx.ui.custom()/editor 同一时间只能处理一个活跃调用，所以
// 所有弹窗类工具（ask_user_question、quiz、……）必须彼此串行化，而不只是各自
// 串行化。我们把一个互斥锁挂在 globalThis 上，这样不同的扩展文件无需互相
// import 就能共享它。
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const g = globalThis as any;
	if (!g[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => { release = r; });
				return prev.then(fn).finally(() => release!());
			},
		};
	}
	return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"向用户问一个单一问题，并暂停执行直到他们回答。当需求模糊、需要用户偏好、某个决定会实质影响实现、或你在继续之前需要确认时使用。每次工具调用只问一个问题，优先用多次单独的工具调用，而不是把不相关的问题捆绑在一起。",
		promptSnippet:
			"在继续之前，用这个工具问恰好一个澄清问题、缺失需求问题、偏好问题或决定问题。",
		promptGuidelines: [
			"每次工具调用只问一个问题。",
			"如果你需要多个问题的答案，进行多次单独的 ask_user_question 工具调用，而不是把它们合并到一个提示里。",
			'当提供选项时，用户总是能选择"Other"来提供自定义文本输入。',
			"只有当你需要对同一个问题收集多个答案时，才使用 multiSelect: true。",
			'如果你推荐某个选项，把它设为列表中的第一项，并在标签末尾加上"(Recommended)"。',
			"当需求、偏好或实现选择不明确时，优先使用这个工具，而不是猜测。",
			"当存在多条有效的实现路径、且首选路径取决于用户选择时，使用这个工具。",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params.options);
			const context = params.details?.trim() || undefined;
			const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}

			if (!ctx.hasUI) {
				return unavailableResult(params.question, mode, "ask_user_question 需要交互式 UI 模式", context);
			}

			return withUILock(async () => {
				if (mode === "text") {
					const editorTitle = context ? `${params.question}\n\n${context}` : params.question;
					const answer = await ctx.ui.editor(editorTitle);
					if (answer === undefined) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [
						{ type: "text", label: answer.trim(), value: answer.trim() },
					]);
				}

				if (mode === "single-select") {
					const answer = await askSingleChoice(ctx, params.question, context, options);
					if (!answer) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [answer]);
				}

				const answers = await askMultiChoice(ctx, params.question, context, options);
				if (!answers) {
					return cancelledResult(params.question, mode, context);
				}
				return buildResult(params.question, context, mode, answers);
			});
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  选项：${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "已取消"), 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question 不可用"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "（空回复）")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
