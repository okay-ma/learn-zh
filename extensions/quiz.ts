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

// ────────────────────────────────────────────────────────────────────────────
// quiz —— ask_user_question 的一个"判分"姊妹工具。
//
// ask_user_question 收集的是没有对错概念的偏好/决定，而 `quiz` 提出一个
// 有正确答案的问题，即时给用户的选择判分，并向用户和代理双方展示紧凑的反馈
// （✓/✗ + 正确答案 + 可选的解释）。
//
// 它有意做成仅选项式：单选或多选。没有自由文本模式，也没有"Other"选项，
// 因为自由文本答案无法对照一个正确索引来判分。
// ────────────────────────────────────────────────────────────────────────────

interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends QuizOption {
	id: string;
	index: number;
	isSubmit?: boolean;
}

interface OptionAnswer {
	label: string;
	value: string;
	index: number; // 1 开始，与展示给用户的编号一致
}

// 始终存在的"我不知道"选项。它不是一个真正的选项：它从不参与洗牌，没有
// 正确答案值，并且产生一个独立信号（dontKnow）而不是对/错评分——这样一次
// 诚实的"我不知道"永远不会被误认为一次走运或倒霉的猜测。
const DONT_KNOW_VALUE = "__dont_know__";
const DONT_KNOW_LABEL = "我不知道";
const DONT_KNOW_INDEX = 0; // 真正的选项从 1 开始；submit 使用 -1

// 来自任一 ask* 组件的统一响应。answers 持有真正的选择（dontKnow 时为空）；
// note 是用户在始终存在的备注字段里输入的可选自由文本（仅当非空时保留）。
interface QuizResponse {
	dontKnow: boolean;
	note?: string;
	answers: OptionAnswer[];
}

type QuizStatus = "answered" | "cancelled" | "unavailable";
type QuizMode = "single-select" | "multi-select";

interface DisplayedOption {
	index: number; // 1 开始，在最终（可能已洗牌）的显示顺序中
	label: string;
}

interface QuizResultDetails {
	status: QuizStatus;
	question: string;
	context?: string;
	mode: QuizMode;
	answers: OptionAnswer[];
	correctIndices: number[];
	options?: DisplayedOption[]; // 按显示顺序的完整选项列表，用于记录
	correct?: boolean;
	dontKnow?: boolean; // 用户选择了"我不知道"而不是猜测
	note?: string; // 来自始终存在的备注字段的可选自由文本（任何答案）
	explanation?: string;
	message?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "答案选项的显示标签。" }),
	value: Type.Optional(
		Type.String({ description: "为该选项返回的可选机器可读值。默认使用标签。" }),
	),
	description: Type.Optional(Type.String({ description: "显示在选项下方的可选额外说明。" })),
});

const QuizParams = Type.Object({
	question: Type.String({
		description: "要问的单个测验题。每次工具调用只问一个问题。",
	}),
	details: Type.Optional(
		Type.String({ description: "显示在问题下方的可选额外上下文或说明。" }),
	),
	options: Type.Array(OptionSchema, {
		description:
			"答案选项（2 个或更多）。仅选项——没有自由文本模式。给每个选项一个稳定的 `value`；你在 correctAnswer 里用那个 value 来引用正确的那个。",
		minItems: 2,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "当不止一个选项正确、且用户必须把它们全部选中时设为 true。" }),
	),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			'必填。作为选项 value(s) 的正确答案——你预期那个选项的 `value` 字段。单选：单个字符串（如 "mercury"）。多选：一个字符串数组（如 ["belize", "niue"]）；只有当用户的选择与该集合完全一致时才判对。始终传 value，不要传位置编号——这是自校验的，能防止数错位置。',
	}),
	explanation: Type.String({
		description:
			"必填。在用户作答之后才揭示的解释（无论答对答错都会显示）。用它来强化为什么正确答案是对的。",
	}),
	shuffle: Type.Optional(
		Type.Boolean({
			description:
				"默认为 true：选项在显示前被随机重排，这样正确答案不会总在同一个位置。仅当选项顺序有意义时（例如有序的数值，或必须留在最后的"All/None of the above"选项）才设为 false。",
		}),
	),
});

function normalizeOptions(
	options: Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
	const seen = new Set<string>();
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => {
			if (option.label.length === 0) return false;
			if (seen.has(option.value)) throw new Error(`重复的选项 value "${option.value}"`);
			seen.add(option.value);
			return true;
		});
}

// 对一份副本做 Fisher-Yates 洗牌。可以安全地重排显示顺序，因为 correctAnswer
// 是按 value 而非位置作为 key 的——索引在洗牌之后才解析，所以评分总是匹配
// 用户实际看到的东西。
function shuffleOptions(options: QuizOption[]): QuizOption[] {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// 把作者提供的选项 value(s) 解析成 1 开始的索引。按 value（而非位置）作 key
// 让正确答案自文档化：作者写 `correctAnswer: "mercury"`，一个笔误就会变成硬
// 错误，而不是一次静默的判错。
// harness 有时会把多选 `correctAnswer` 数组以 JSON 字符串化的字符串形式
// （如 '["a", "b"]'）而不是真正的数组传进来，因为 schema 的 union 把 String
// 列在前面。检测这种情况并把它解析回数组，这样评分才能对照真正的选项 value
// 来解析。一个普通的单个 value 就原样包装。
function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
	if (Array.isArray(correctAnswer)) return correctAnswer;
	const trimmed = correctAnswer.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map((v) => String(v));
		} catch {
			// 不是合法 JSON——继续往下，当作单个字面值处理。
		}
	}
	return [correctAnswer];
}

function resolveCorrect(
	correctAnswer: string | string[] | undefined,
	options: QuizOption[],
): { indices: number[]; error?: string } {
	if (correctAnswer === undefined) return { indices: [], error: "correctAnswer 是必填的" };
	const arr = coerceCorrectAnswer(correctAnswer);
	if (arr.length === 0) return { indices: [], error: "correctAnswer 是必填的" };
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices: number[] = [];
	for (const raw of arr) {
		const v = typeof raw === "string" ? raw.trim() : raw;
		const idx = byValue.get(v);
		if (idx === undefined) {
			const known = options.map((o) => `"${o.value}"`).join(", ");
			return { indices: [], error: `correctAnswer "${v}" 不匹配任何选项 value（${known}）` };
		}
		indices.push(idx);
	}
	return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
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

function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((v, i) => v === b[i]);
}

function buildStructuredResult(
	status: QuizStatus,
	question: string,
	mode: QuizMode,
	answers: OptionAnswer[],
	correctIndices: number[],
	correct: boolean | undefined,
	explanation: string | undefined,
	context?: string,
	message?: string,
	options?: DisplayedOption[],
	dontKnow?: boolean,
	note?: string,
): QuizResultDetails {
	return { status, question, context, mode, answers, correctIndices, options, correct, dontKnow, note, explanation, message };
}

function cancelledResult(question: string, mode: QuizMode, correctIndices: number[], context?: string) {
	const message = "用户取消了测验";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], correctIndices, undefined, undefined, context, message),
	};
}

function unavailableResult(question: string, mode: QuizMode, message: string, correctIndices: number[], context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], correctIndices, undefined, undefined, context, message),
	};
}

function formatOptionRef(options: QuizOption[], index: number): string {
	const opt = options.find((o, i) => i + 1 === index);
	return `${index}. ${opt ? opt.label : "（未知）"}`;
}

function buildResult(
	question: string,
	context: string | undefined,
	mode: QuizMode,
	options: QuizOption[],
	response: QuizResponse,
	correctIndices: number[],
	explanation: string | undefined,
) {
	const { dontKnow, note, answers } = response;
	const selectedIndices = answers.map((a) => a.index);
	// "我不知道"从不算正确——它是一种独立的结果。
	const correct = dontKnow ? false : isCorrect(selectedIndices, correctIndices);
	const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
	const displayedOptions: DisplayedOption[] = options.map((o, i) => ({ index: i + 1, label: o.label }));

	let text: string;
	if (dontKnow) {
		// 让这个信号对代理明确：用户没有猜测，所以这是一个真正的知识缺口，
		// 不是一次需要对照纠正的错误答案。
		text = `用户选择了"我不知道"——他们没有尝试作答（这是一个真正的知识缺口，而不是一次猜错）。`;
		text += `\n正确答案：${correctStr}`;
		if (note) text += `\n用户的备注：${note}`;
	} else {
		const verdict = correct ? "正确" : "错误";
		const selectedStr = answers.map((a) => `${a.index}. ${a.label}`).join(", ");
		text = `用户回答${verdict}。\n已选择：${selectedStr}\n正确答案：${correctStr}`;
		if (note) text += `\n用户的备注：${note}`;
	}
	if (explanation) text += `\n解释：${explanation}`;

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult(
			"answered",
			question,
			mode,
			answers,
			correctIndices,
			correct,
			explanation,
			context,
			undefined,
			displayedOptions,
			dontKnow,
			note,
		),
	};
}

// 共享反馈块，在用户提交后渲染。
function renderFeedback(
	lines: string[],
	theme: any,
	width: number,
	options: QuizOption[],
	selectedIndices: number[],
	correctIndices: number[],
	explanation: string | undefined,
	dontKnow = false,
	note?: string,
): void {
	const add = (text: string) => lines.push(truncateToWidth(text, width));
	const correct = !dontKnow && isCorrect(selectedIndices, correctIndices);
	const selectedSet = new Set(selectedIndices);
	const correctSet = new Set(correctIndices);

	lines.push("");
	for (let i = 0; i < options.length; i++) {
		const index = i + 1;
		const opt = options[i];
		const isSelected = selectedSet.has(index);
		const isKey = correctSet.has(index);
		let marker: string;
		let color: string;
		if (dontKnow) {
			// 没有猜测——只揭示正确答案；绝不显示 ✗。
			marker = isKey ? "✓" : " ";
			color = isKey ? "success" : "dim";
		} else if (isSelected && isKey) {
			marker = "✓";
			color = "success";
		} else if (isSelected && !isKey) {
			marker = "✗";
			color = "error";
		} else if (!isSelected && isKey) {
			// 用户错过的正确答案
			marker = "✓";
			color = "success";
		} else {
			marker = " ";
			color = "dim";
		}
		add(theme.fg(color, ` ${marker} ${index}. ${opt.label}`));
	}

	lines.push("");
	if (dontKnow) {
		add(theme.fg("warning", " · 你选择了：我不知道"));
		const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
		addWrapped(lines, theme.fg("muted", `正确答案：${correctStr}`), width, " ");
	} else if (correct) {
		add(theme.fg("success", " ✓ 正确！"));
	} else {
		add(theme.fg("error", " ✗ 错误。"));
		const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
		addWrapped(lines, theme.fg("muted", `正确答案：${correctStr}`), width, " ");
	}
	if (note) {
		addWrapped(lines, theme.fg("muted", `你的备注：${note}`), width, " ");
	}
	if (explanation) {
		lines.push("");
		addWrapped(lines, theme.fg("text", explanation), width, " ");
	}
	lines.push("");
	add(theme.fg("dim", " Enter/Esc 继续"));
}

// 顶部边框 + 问题 + 可选上下文。两个组件共用。
function pushHeader(lines: string[], theme: any, width: number, question: string, context: string | undefined): void {
	lines.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
	addWrapped(lines, theme.fg("text", question), width, " ");
	if (context) {
		lines.push("");
		addWrapped(lines, theme.fg("muted", context), width, " ");
	}
}

// 选择列表里的"我不知道"行——视觉上分隔并变暗，让它读起来与真正的、可评分
// 的选项区分开。
function pushDontKnowRow(lines: string[], theme: any, width: number, focused: boolean): void {
	lines.push("");
	const prefix = focused ? theme.fg("accent", "> ") : "  ";
	const styled = focused ? theme.fg("accent", DONT_KNOW_LABEL) : theme.fg("dim", DONT_KNOW_LABEL);
	lines.push(truncateToWidth(`${prefix}${styled}`, width));
}

// 在选择阶段渲染于选项下方的常驻、始终存在的备注字段。适用于任何答案
// （包括"我不知道"），仅当非空时才浮给代理。
function pushNoteField(lines: string[], theme: any, width: number, editor: Editor, focused: boolean): void {
	lines.push("");
	const label = focused ? theme.fg("accent", "备注（可选）：") : theme.fg("muted", "备注（可选）：");
	addWrapped(lines, label, width, " ");
	for (const line of editor.render(width)) lines.push(line);
}

// 构建备注 Editor。`disableSubmit` 之所以要设，是因为这里的 Enter 绝不能提交：
// editor 的提交路径会清空缓冲区，那会抹掉备注。取而代之，宿主拦截 Enter 把
// 焦点还给选项，同时保留文字。Ctrl+J 仍会插入换行（pi 约定），所以多行备注
// 可行。
function makeNoteEditor(tui: any, theme: any): Editor {
	const editor = new Editor(tui, createEditorTheme(theme));
	editor.focused = false;
	editor.disableSubmit = true;
	return editor;
}

async function askSingleChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: QuizOption[],
	correctIndices: number[],
	explanation: string | undefined,
): Promise<QuizResponse | null> {
	const allOptions: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const dontKnowNav = allOptions.length; // "我不知道"行的导航索引

	return ctx.ui.custom<QuizResponse | null>(
		(tui: any, theme: any, _kb: any, done: (result: QuizResponse | null) => void) => {
			let optionIndex = 0;
			let phase: "select" | "feedback" = "select";
			let focus: "options" | "note" = "options";
			let chosen: OptionAnswer | null = null;
			let dontKnow = false;
			const editor = makeNoteEditor(tui, theme);
			let cachedLines: string[] | undefined;
			let cachedWidth = -1;

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function noteText(): string | undefined {
				const t = editor.getText().trim();
				return t.length ? t : undefined;
			}

			function toOptions() {
				focus = "options";
				editor.focused = false;
				refresh();
			}

			function response(): QuizResponse {
				const note = noteText();
				return dontKnow
					? { dontKnow: true, note, answers: [] }
					: { dontKnow: false, note, answers: chosen ? [chosen] : [] };
			}

			function handleInput(data: string) {
				if (phase === "feedback") {
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						done(response());
					}
					return;
				}

				// Tab 在选项列表和备注字段之间切换焦点。
				if (matchesKey(data, Key.tab)) {
					focus = focus === "options" ? "note" : "options";
					editor.focused = focus === "note";
					refresh();
					return;
				}

				if (focus === "note") {
					// Enter 和 Esc 都返回选项并保留备注文字。
					// （这里必须拦截 Enter：editor 自己的提交会清空缓冲区。Ctrl+J
					// 仍然会作为换行到达 editor。）
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						toOptions();
						return;
					}
					editor.handleInput(data);
					tui.requestRender();
					return;
				}

				// focus === "options"
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(dontKnowNav, optionIndex + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (optionIndex === dontKnowNav) {
						dontKnow = true;
						chosen = null;
					} else {
						const selected = allOptions[optionIndex];
						chosen = { label: selected.label, value: selected.value, index: selected.index };
						dontKnow = false;
					}
					phase = "feedback";
					refresh();
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
				pushHeader(lines, theme, width, question, context);

				if (phase === "feedback") {
					renderFeedback(
						lines,
						theme,
						width,
						options,
						chosen ? [chosen.index] : [],
						correctIndices,
						explanation,
						dontKnow,
						noteText(),
					);
					add(theme.fg("accent", "─".repeat(width)));
					cachedLines = lines;
					cachedWidth = width;
					return lines;
				}

				lines.push("");
				for (let i = 0; i < allOptions.length; i++) {
					const option = allOptions[i];
					const selected = focus === "options" && i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = `${option.index}. ${option.label}`;
					const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
					add(`${prefix}${styled}`);
					if (option.description) {
						addWrapped(lines, theme.fg("muted", option.description), width, "     ");
					}
				}

				pushDontKnowRow(lines, theme, width, focus === "options" && optionIndex === dontKnowNav);

				pushNoteField(lines, theme, width, editor, focus === "note");

				lines.push("");
				if (focus === "note") {
					add(theme.fg("dim", " 输入备注 • Ctrl+J 换行 • Enter 返回选项 • Tab 选项 • Esc 返回"));
				} else {
					add(theme.fg("dim", " ↑↓ 导航 • Enter 作答 • Tab 备注 • Esc 取消"));
				}
				add(theme.fg("accent", "─".repeat(width)));
				// 备注聚焦时不缓存：editor 渲染一个实时光标。
				if (focus !== "note") {
					cachedLines = lines;
					cachedWidth = width;
				}
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
					editor.invalidate();
				},
				handleInput,
			};
		},
	);
}

async function askMultiChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: QuizOption[],
	correctIndices: number[],
	explanation: string | undefined,
): Promise<QuizResponse | null> {
	const DONT_KNOW_ID = "dont-know";
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const dontKnowItem: DisplayOption = {
		id: DONT_KNOW_ID,
		label: DONT_KNOW_LABEL,
		value: DONT_KNOW_VALUE,
		index: DONT_KNOW_INDEX,
	};
	const submitItem: DisplayOption = { id: "submit", label: "提交", value: "__submit__", index: -1, isSubmit: true };
	const allItems: DisplayOption[] = [...choiceItems, dontKnowItem, submitItem];

	return ctx.ui.custom<QuizResponse | null>(
		(tui: any, theme: any, _kb: any, done: (result: QuizResponse | null) => void) => {
			let optionIndex = 0;
			let phase: "select" | "feedback" = "select";
			let focus: "options" | "note" = "options";
			const editor = makeNoteEditor(tui, theme);
			let cachedLines: string[] | undefined;
			let cachedWidth = -1;
			const selected = new Map<string, OptionAnswer>();

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function noteText(): string | undefined {
				const t = editor.getText().trim();
				return t.length ? t : undefined;
			}

			function toOptions() {
				focus = "options";
				editor.focused = false;
				refresh();
			}

			const choseDontKnow = () => selected.has(DONT_KNOW_ID);
			const realAnswers = () =>
				sortAnswers(Array.from(selected.values()).filter((a) => a.index !== DONT_KNOW_INDEX));

			function response(): QuizResponse {
				const note = noteText();
				return choseDontKnow()
					? { dontKnow: true, note, answers: [] }
					: { dontKnow: false, note, answers: realAnswers() };
			}

			// "我不知道"是互斥的：选择它会清空真正的选择，而选择任何真正的选项
			// 会清掉"我不知道"。
			function toggleOption(item: DisplayOption) {
				if (item.id === DONT_KNOW_ID) {
					if (selected.has(DONT_KNOW_ID)) {
						selected.delete(DONT_KNOW_ID);
					} else {
						selected.clear();
						selected.set(DONT_KNOW_ID, { label: item.label, value: item.value, index: item.index });
					}
				} else {
					selected.delete(DONT_KNOW_ID);
					if (selected.has(item.id)) {
						selected.delete(item.id);
					} else {
						selected.set(item.id, { label: item.label, value: item.value, index: item.index });
					}
				}
				refresh();
			}

			function submit() {
				if (selected.size === 0) return;
				phase = "feedback";
				refresh();
			}

			function handleInput(data: string) {
				if (phase === "feedback") {
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						done(response());
					}
					return;
				}

				// Tab 在选项列表和备注字段之间切换焦点。
				if (matchesKey(data, Key.tab)) {
					focus = focus === "options" ? "note" : "options";
					editor.focused = focus === "note";
					refresh();
					return;
				}

				if (focus === "note") {
					// Enter 和 Esc 都返回选项并保留备注文字。
					// （这里必须拦截 Enter：editor 自己的提交会清空缓冲区。Ctrl+J
					// 仍然会作为换行到达 editor。）
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						toOptions();
						return;
					}
					editor.handleInput(data);
					tui.requestRender();
					return;
				}

				// focus === "options"
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
					toggleOption(current);
					return;
				}

				if (matchesKey(data, Key.enter)) {
					if (current.isSubmit) {
						submit();
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
				pushHeader(lines, theme, width, question, context);

				if (phase === "feedback") {
					renderFeedback(
						lines,
						theme,
						width,
						options,
						realAnswers().map((a) => a.index),
						correctIndices,
						explanation,
						choseDontKnow(),
						noteText(),
					);
					add(theme.fg("accent", "─".repeat(width)));
					cachedLines = lines;
					cachedWidth = width;
					return lines;
				}

				lines.push("");
				for (let i = 0; i < allItems.length; i++) {
					const item = allItems[i];
					const isFocused = focus === "options" && i === optionIndex;
					const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

					if (item.isSubmit) {
						const label = selected.size > 0 ? `✓ ${item.label}（已选 ${selected.size}）` : `○ ${item.label}`;
						const styled = isFocused
							? theme.fg("accent", label)
							: theme.fg(selected.size > 0 ? "success" : "dim", label);
						add(`${prefix}${styled}`);
						continue;
					}

					if (item.id === DONT_KNOW_ID) {
						lines.push(""); // 与真正选项之间的视觉分隔
						const checked = selected.has(item.id);
						const label = `${checked ? "[x]" : "[ ]"} ${item.label}`;
						const styled = isFocused ? theme.fg("accent", label) : theme.fg(checked ? "warning" : "dim", label);
						add(`${prefix}${styled}`);
						continue;
					}

					const checked = selected.has(item.id);
					const marker = checked ? "[x]" : "[ ]";
					const label = `${marker} ${item.index}. ${item.label}`;
					const styled = isFocused ? theme.fg("accent", label) : theme.fg(checked ? "success" : "text", label);
					add(`${prefix}${styled}`);
					if (item.description) {
						addWrapped(lines, theme.fg("muted", item.description), width, "     ");
					}
				}

				pushNoteField(lines, theme, width, editor, focus === "note");

				lines.push("");
				if (selected.size === 0) {
					add(theme.fg("warning", " 提交前至少选择一个答案。"));
				}
				if (focus === "note") {
					add(theme.fg("dim", " 输入备注 • Ctrl+J 换行 • Enter 返回选项 • Tab 选项 • Esc 返回"));
				} else {
					add(theme.fg("dim", " ↑↓ 导航 • Space 切换 • Enter 提交 • Tab 备注 • Esc 取消"));
				}
				add(theme.fg("accent", "─".repeat(width)));
				// 备注聚焦时不缓存：editor 渲染一个实时光标。
				if (focus !== "note") {
					cachedLines = lines;
					cachedWidth = width;
				}
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
					editor.invalidate();
				},
				handleInput,
			};
		},
	);
}

function sortAnswers(answers: OptionAnswer[]): OptionAnswer[] {
	return [...answers].sort((a, b) => a.index - b.index);
}

// 共享 UI 互斥锁。ctx.ui.custom()/editor 同一时间只能处理一个活跃调用，所以
// 所有弹窗类工具（quiz、ask_user_question、……）必须彼此串行化，而不只是各自
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

export default function quiz(pi: ExtensionAPI) {
	pi.registerTool({
		name: "quiz",
		label: "quiz",
		description:
			"向用户问一个有已知正确答案的判分问题，然后即时判分并给出反馈。与 ask_user_question（收集没有正确答案的偏好/决定）不同，quiz 总是由你提供一个正确答案，把用户的选择标记为对/错（✓/✗），揭示正确答案，并可显示解释。用它来（1）在教学前评估学习者已经理解了什么，以及（2）在讲解后运行紧凑的练习/提取循环，或在你拿不准他们是否掌握时探测理解。仅选项式：单选或多选，外加一个自动的"我不知道"选项，让用户能标示一个真正的缺口而不是猜测。一个始终存在、可选（按 Tab 聚焦）的备注字段让用户能给任何答案附加自由文本备注；它只在非空时才到达你。没有自由文本答案——对于非判分问题请改用 ask_user_question。",
		promptSnippet:
			"用 quiz 工具以一道判分的选择题或多选题来测试用户（必填正确答案 + 必填解释）。对于非判分问题，使用 ask_user_question。",
		promptGuidelines: [
			"quiz 是判分的；ask_user_question 不是。如果问题有正确答案，用 quiz。如果你只是需要偏好、决定或开放式输入，用 ask_user_question。",
			'correctAnswer 是必填的，并且是选项 value 而非位置编号。单选：一个字符串（如 "mercury"）。多选：一个字符串数组（如 ["belize", "niue"]）。',
			"始终把选项的 `value` 字符串作为 correctAnswer 传入——它是自校验的，能防止数错位置。一个匹配不到任何选项的 value 是硬错误。",
			"explanation 是必填的——始终说明为什么正确答案是对的。",
			"多选按精确集合匹配判分：只有当用户选中每一个正确选项、且没有选任何错误选项时才判对。",
			"没有自由文本模式。一个"我不知道"选项总是被自动加上——只提供真正的、可评分的选项（至少两个）。绝不要自己添加不确定/退出类选项，如"I don't know"、"I'm not sure"或"Not sure"；那已由系统处理，手动加一个会是多余的、或会被当作可评分的错误项。",
			"如果结果以 dontKnow 返回，说明用户诚实地不知道且没有猜测——把它当作一个需要教进去的真正知识缺口，而不是一次错误答案。",
			"任何答案（对、错或"我不知道"）都可能带一个可选的自由文本 `note`，是用户在始终存在的备注字段里输入的。当它存在时反映他们当时的想法或不确定之处——读它并让它引导你的后续。为空时它被完全省略。",
			"把每个错误答案（干扰项）当作诊断探针，而不只是填充物：把它做成用户可能真会持有的一个具体、可信的错误——一个常见误解，或一个相邻/易混淆的概念——这样他选中的是哪一个错误项，就揭示了理解中哪一处细微差别出了问题。从一个有指向性的错误选择中学到的，远多于从二元的对/错中学到的，而这个选择精确告诉你下一个要教进哪个缺口（以及解释应该针对什么）。",
			"护栏：每个干扰项在预期读法下都必须毫无歧义地是错的——有诱惑力，但是一个真实错误，不是一个可辩护的替代项。不要滑向陷阱题。",
			"反猜测卫生：不要让正确答案在形式上突出（最长、最精确、最多限定、或唯一格式正确的那个）。保持选项在长度、具体性和措辞上相近，这样它无法仅凭外形被选出。",
			"仅当不止一个选项正确时才设 multiSelect: true。",
			"选项默认在显示前洗牌，所以不用担心你把正确答案列在哪个位置。仅当选项顺序有意义时才设 shuffle: false（有序数值，或必须留在最后的"All/None of the above"选项）。",
			"要探测细微差别，快速问几道 quiz 题，每道都根据前一道的作答来调整，而不是写一道巨型题。",
			"不要通过格式泄漏答案：保持选项措辞/长度均衡，不要暗示哪个是对的。",
		],
		parameters: QuizParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const context = params.details?.trim() || undefined;
			const explanation = params.explanation.trim();
			const mode: QuizMode = params.multiSelect ? "multi-select" : "single-select";

			let options: QuizOption[];
			try {
				options = normalizeOptions(params.options);
			} catch (e) {
				return unavailableResult(params.question, mode, `quiz ${(e as Error).message}`, [], context);
			}

			// 在解析正确索引之前先洗牌（默认开启），这样评分才匹配用户看到的顺序。
			if (params.shuffle !== false) {
				options = shuffleOptions(options);
			}

			// 立即发出真实（洗牌后）的显示顺序，在 UI 阻塞等待用户答案之前。
			// 诸如 md-log 之类的监听器依赖它来以用户实际看到的相同顺序显示问题，
			// 而不是代理在工具调用里最初写下的洗牌前顺序。
			// 有意省略 correctIndices/explanation——它在用户作答之前触发，绝不能
			// 泄漏答案。
			onUpdate?.({
				content: [{ type: "text", text: "等待用户回复……" }],
				details: { options: options.map((o, i) => ({ index: i + 1, label: o.label })) },
			});

			const { indices: correctIndices, error: correctError } = resolveCorrect(
				params.correctAnswer as string | string[],
				options,
			);

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, correctIndices, context);
			}

			if (options.length < 2) {
				return unavailableResult(
					params.question,
					mode,
					"quiz 需要至少两个选项",
					correctIndices,
					context,
				);
			}

			if (correctError) {
				return unavailableResult(params.question, mode, `quiz ${correctError}`, correctIndices, context);
			}

			if (!ctx.hasUI) {
				return unavailableResult(params.question, mode, "quiz 需要交互式 UI 模式", correctIndices, context);
			}

			return withUILock(async () => {
				const response =
					mode === "single-select"
						? await askSingleChoice(ctx, params.question, context, options, correctIndices, explanation)
						: await askMultiChoice(ctx, params.question, context, options, correctIndices, explanation);
				if (!response) {
					return cancelledResult(params.question, mode, correctIndices, context);
				}
				return buildResult(params.question, context, mode, options, response, correctIndices, explanation);
			});
		},

		renderCall(args, theme) {
			// 注意：绝不在这里渲染 correctAnswer 或 explanation——那会在用户作答前
			// 把答案泄漏进记录。我们也不在这里枚举选项：它们在 execute 时被洗牌，
			// 所以流式期间显示的任何顺序都将是陈旧的/误导性的。完整选项列表在用户
			// 作答后由 renderResult 以其真实显示顺序渲染。
			const options = normalizeOptions(
				args.options as Array<{ label: string; value?: string; description?: string }> | undefined,
			);
			let text = theme.fg("toolTitle", theme.bold("quiz ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				text += theme.fg("dim", `（${options.length} 个选项）`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuizResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "已取消"), 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "quiz 不可用"), 0, 0);
			}

			const correctSet = new Set(details.correctIndices);
			const selectedSet = new Set(details.answers.map((a) => a.index));
			const lines: string[] = [];

			// 完整选项列表，以其真实（洗牌后）显示顺序，带 ✓/✗ 标记。
			// 对于早于 details.options 的旧结果，回退到仅显示选中的答案。
			const displayed =
				details.options && details.options.length > 0
					? details.options
					: details.answers.map((a) => ({ index: a.index, label: a.label }));

			for (const opt of displayed) {
				const isSelected = selectedSet.has(opt.index);
				const isKey = correctSet.has(opt.index);
				let mark: string;
				let body: string;
				if (details.dontKnow) {
					// 没有猜测——只揭示正确答案；绝不显示 ✗。
					mark = isKey ? theme.fg("success", "✓ ") : "  ";
					body = isKey ? theme.fg("success", `${opt.index}. ${opt.label}`) : theme.fg("dim", `${opt.index}. ${opt.label}`);
				} else if (isSelected && isKey) {
					mark = theme.fg("success", "✓ ");
					body = theme.fg("accent", `${opt.index}. ${opt.label}`);
				} else if (isSelected && !isKey) {
					mark = theme.fg("error", "✗ ");
					body = theme.fg("error", `${opt.index}. ${opt.label}`);
				} else if (!isSelected && isKey) {
					mark = theme.fg("success", "✓ ");
					body = theme.fg("success", `${opt.index}. ${opt.label}`);
				} else {
					mark = "  ";
					body = theme.fg("dim", `${opt.index}. ${opt.label}`);
				}
				lines.push(`${mark}${body}`);
			}

			lines.push("");
			const verdict = details.dontKnow
				? theme.fg("warning", "我不知道")
				: details.correct
					? theme.fg("success", "正确！")
					: theme.fg("error", "错误");
			lines.push(verdict);

			if (details.note) {
				lines.push(theme.fg("muted", `备注：${details.note}`));
			}

			if (details.explanation) {
				lines.push(theme.fg("muted", details.explanation));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
