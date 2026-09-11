/**
 * md-log —— 把会话镜像到一个 markdown 文件，以便舒适地阅读。
 *
 * 为长时间的教学/学习会话设计，因为终端对眼睛不友好，且 markdown/数学/代码
 * 无法渲染。被链接的 .md 文件本意是被渲染查看（例如在 Obsidian 中），所以带
 * $...$ 数学、代码块和 markdown 的助手文本都能原生渲染——这里无需做渲染工作。
 *
 * 只捕获与阅读相关的内容：
 *   - 用户提示
 *   - 助手文本（课程散文）
 *   - quiz / ask_user_question 的问答块
 * 其他工具（bash、read、write、edit、……）被省略。
 *
 * Quiz/ask 问题在用户作答之前写入（在 tool_call 时），这样读者能看到问题实时
 * 出现；答案 + 反馈在 tool_result 时追加。问题块绝不含正确答案或解释（用户会
 * 实时阅读这个文件）。
 *
 * 命令：
 *   /md-log <文件路径>  —— 链接一个 markdown 文件并回填会话。
 *   /md-unlog           —— 停止记录。
 *
 * 仅追加。没有"回传给代理"功能（那存在于本扩展所仿照的旧 .md-link 扩展里）。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;

	// --- 会话重启时的状态恢复 ---

	pi.on("session_start", async (_event, ctx) => {
		let lastLinkData: { file: string | null } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "md-log") {
				lastLinkData = entry.data as { file: string | null } | undefined;
			}
		}
		if (lastLinkData?.file) {
			logFile = lastLinkData.file;
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"md-log",
				theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(logFile)),
			);
		}
	});

	// --- 串行化：事件可能紧挨着触发；保持追加有序 ---

	let writeLock: Promise<void> = Promise.resolve();
	function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = writeLock;
		let release: () => void;
		writeLock = new Promise<void>((r) => {
			release = r;
		});
		return prev.then(fn).finally(() => release!());
	}

	function appendToFile(text: string): void {
		if (!logFile) return;
		try {
			let current = "";
			if (fs.existsSync(logFile)) {
				current = fs.readFileSync(logFile, "utf-8");
			}
			const prefix = current.trim().length > 0 ? "\n\n" : "";
			fs.writeFileSync(logFile, current + prefix + text + "\n", "utf-8");
		} catch {
			// 文件可能已在外部被删除；忽略。
		}
	}

	// --- 格式化 ---

	function callout(type: string, title: string, bodyLines: string[]): string {
		const lines = [`> [!${type}] ${title}`];
		for (const line of bodyLines) {
			lines.push(line.length === 0 ? ">" : `> ${line}`);
		}
		return lines.join("\n");
	}

	function userBlock(text: string): string {
		return `> [!quote] 你\n\n${text}`;
	}

	// Skill 声明（`<skill name="..." ...> ...整个 SKILL.md... </skill>`）
	// 是系统注入的上下文，不是用户散文。把每个替换成一个注明 skill 已加载的
	// 紧凑 callout，这样日志保留信号而不保留噪音。作用在已 trim 的文本上。
	function stripSkillBlocks(text: string): string {
		return text.replace(
			/<skill\b([^>]*)>[\s\S]*?<\/skill>/g,
			(_match, attrs: string) => {
				const name = /name="([^"]+)"/.exec(attrs)?.[1];
				return `> [!note] 已加载 SKILL：${name ?? "（未知）"}`;
			},
		);
	}

	function assistantBlock(text: string): string {
		return `> [!abstract] PI\n\n${text}`;
	}

	function optionsList(options: Array<{ label: string }>): string[] {
		return options.map((o, i) => `${i + 1}. ${o.label}`);
	}

	function questionCallout(label: string, question: string, context: string | undefined, options: Array<{ label: string }>): string {
		const body: string[] = [];
		for (const line of question.split("\n")) body.push(line);
		if (context) {
			body.push("");
			for (const line of context.split("\n")) body.push(line);
		}
		if (options.length > 0) {
			body.push("");
			body.push(...optionsList(options));
		}
		return callout("question", label, body);
	}

	function answerCalloutQuiz(details: any): string {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("warning", "测验——已取消", ["（用户跳过）"]);
		}
		if (status === "unavailable") {
			return callout("warning", "测验——不可用", [details?.message || ""]);
		}
		// "我不知道"既不正确也不错误——它是一个独立信号，所以绝不渲染成红色 ✗。
		const dontKnow = details?.dontKnow === true;
		const correct = details?.correct === true;
		const type = dontKnow ? "question" : correct ? "success" : "failure";
		const title = dontKnow
			? "测验——我不知道"
			: correct
				? "测验——正确 ✓"
				: "测验——错误 ✗";
		const body: string[] = [];

		if (dontKnow) {
			body.push("你的答案：我不知道");
		} else {
			const answers: any[] = details?.answers || [];
			const sel = answers.map((a) => `${a.index}. ${a.label}`).join(", ") || "（无）";
			body.push(`你的答案：${sel}`);
		}

		const correctIndices: number[] = details?.correctIndices || [];
		const correctStr = correctIndices.map((i) => `${i}`).join(", ");
		body.push(`正确答案：${correctStr}`);

		// 用户在始终存在的备注字段里输入的可选自由文本备注。
		// 仅在非空时才出现在 details 里，所以无需为空字符串做保护。
		if (details?.note) {
			body.push("");
			const noteLines = String(details.note).split("\n");
			body.push(`备注：${noteLines[0]}`);
			for (let i = 1; i < noteLines.length; i++) body.push(noteLines[i]);
		}

		if (details?.explanation) {
			body.push("");
			for (const line of String(details.explanation).split("\n")) body.push(line);
		}
		return callout(type, title, body);
	}

	function answerCalloutAsk(details: any): string {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("warning", "问题——已取消", ["（用户跳过）"]);
		}
		if (status === "unavailable") {
			return callout("warning", "问题——不可用", [details?.message || ""]);
		}
		const answers: any[] = details?.answers || [];
		const body: string[] = answers.map((a) => {
			if (a.type === "other") return `其他：${a.label}`;
			if (a.type === "text") return a.label;
			return `${a.index}. ${a.label}`;
		});
		if (body.length === 0) body.push("（无答案）");
		return callout("example", "回答", body);
	}

	// --- 事件处理器 ---

	pi.on("message_end", async (event, _ctx) => {
		if (!logFile) return;
		const msg = event.message;
		if (!msg || !("role" in msg)) return;

		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
					: "";
			const trimmed = stripSkillBlocks(text.trim());
			if (!trimmed) return;
			await withLock(() => appendToFile(userBlock(trimmed)));
			return;
		}

		if (msg.role === "assistant") {
			const textParts = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => (c.text as string).trim())
				.filter((t: string) => t.length > 0);
			if (textParts.length === 0) return;
			await withLock(() => appendToFile(assistantBlock(textParts.join("\n\n"))));
			return;
		}
		// toolResult 消息由 tool_result 事件处理（针对 QA 工具）。
	});

	// ask_user_question 从不洗牌它的选项，所以 tool_call 参数已经是真实的显示
	// 顺序——可以在用户作答之前安全地实时写入问题。
	pi.on("tool_call", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (toolName !== "ask_user_question") return;
		const input = (event as any).input || {};
		const question: string = input.question || "";
		const context: string | undefined = input.details?.trim() || undefined;
		const options: Array<{ label: string }> = Array.isArray(input.options) ? input.options : [];
		const block = questionCallout("问题", question, context, options);
		await withLock(() => appendToFile(block));
	});

	// quiz 确实在 execute() 内部洗牌它的选项，所以 tool_call 参数是洗牌前的
	// 作者顺序——不是用户所看到的。quiz 会在阻塞等待用户答案之前发出一个带真实
	// （洗牌后）顺序的 onUpdate()；改为等它，这样记录的顺序才总是匹配屏幕上的
	// 顺序。用集合防止同一调用的多次 update 导致重复写入。
	const loggedQuizQuestion = new Set<string>();
	pi.on("tool_execution_update", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (toolName !== "quiz") return;
		const toolCallId = (event as any).toolCallId;
		if (loggedQuizQuestion.has(toolCallId)) return;
		const shuffled = (event as any).partialResult?.details?.options as Array<{ index: number; label: string }> | undefined;
		if (!shuffled || shuffled.length === 0) return;
		loggedQuizQuestion.add(toolCallId);
		const input = (event as any).args || {};
		const question: string = input.question || "";
		const context: string | undefined = input.details?.trim() || undefined;
		const options = shuffled.map((o) => ({ label: o.label }));
		const block = questionCallout("测验", question, context, options);
		await withLock(() => appendToFile(block));
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (!QA_TOOLS.has(toolName)) return;
		const details = (event as any).details;
		const block = toolName === "quiz"
			? answerCalloutQuiz(details)
			: answerCalloutAsk(details);
		await withLock(() => appendToFile(block));
	});

	// --- 命令 ---

	pi.registerCommand("md-log", {
		description: "把会话镜像到一个 markdown 文件（回填历史）",
		handler: async (args, ctx: any) => {
			const filepath = args.trim();
			if (!filepath) {
				ctx.ui.notify("用法：/md-log <文件路径>", "warning");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("先等代理完成，再链接文件。", "warning");
				return;
			}

			const resolved = path.isAbsolute(filepath) ? filepath : path.resolve(ctx.cwd, filepath);

			// 文件必须已经存在——/md-log 链接进一个现有笔记，它从不创建笔记。
			// 这避免因一个打错的路径而静默散落新文件（和父目录）到 vault 里。
			if (!fs.existsSync(resolved)) {
				ctx.ui.notify(`文件不存在：${resolved}`, "error");
				return;
			}
			if (!fs.statSync(resolved).isFile()) {
				ctx.ui.notify(`不是文件：${resolved}`, "error");
				return;
			}

			logFile = resolved;
			pi.appendEntry("md-log", { file: resolved });

			// 回填活动分支。
			const written = backfill(ctx);

			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"md-log",
				theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(resolved)),
			);
			ctx.ui.notify(`已链接：${resolved}（回填 ${written} 条）`, "success");
		},
	});

	pi.registerCommand("md-unlog", {
		description: "停止把会话镜像到 markdown 文件",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("没有链接文件", "warning");
				return;
			}
			const name = path.basename(logFile);
			logFile = null;
			pi.appendEntry("md-log", { file: null });
			ctx.ui.setStatus("md-log", undefined);
			ctx.ui.notify(`已取消链接：${name}`, "info");
		},
	});

	// --- 回填 ---

	function backfill(ctx: any): number {
		if (!logFile) return 0;
		const entries: any[] = ctx.sessionManager.getEntries();
		if (entries.length === 0) return 0;

		const byId = new Map<string, any>();
		for (const e of entries) if (e.id) byId.set(e.id, e);

		// 活动叶子 = 最后一个有 id 的条目（跳过会话头）。
		let leaf: any = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].id) {
				leaf = entries[i];
				break;
			}
		}
		if (!leaf) return 0;

		// 沿父链走到根。
		const chain: any[] = [];
		let cur: any = leaf;
		const seen = new Set<string>();
		while (cur && cur.id && !seen.has(cur.id)) {
			seen.add(cur.id);
			chain.push(cur);
			cur = cur.parentId ? byId.get(cur.parentId) : null;
		}
		chain.reverse();

		// 从助手消息追踪 tool-call 参数，以便与结果配对。
		const toolCallArgs = new Map<string, { name: string; args: any }>();

		const blocks: string[] = [];
		let count = 0;
		for (const entry of chain) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg || !("role" in msg)) continue;
			count++;

			if (msg.role === "user") {
				const text = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
						: "";
				const trimmed = stripSkillBlocks(text.trim());
				if (trimmed) blocks.push(userBlock(trimmed));
				continue;
			}

			if (msg.role === "assistant") {
				// 为之后的配对索引工具调用。
				for (const c of msg.content || []) {
					if (c.type === "toolCall" && QA_TOOLS.has(c.name)) {
						toolCallArgs.set(c.id, { name: c.name, args: c.arguments });
					}
				}
				const textParts = (msg.content || [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => (c.text as string).trim())
					.filter((t: string) => t.length > 0);
				if (textParts.length > 0) blocks.push(assistantBlock(textParts.join("\n\n")));
				continue;
			}

			if (msg.role === "toolResult") {
				if (!QA_TOOLS.has(msg.toolName)) continue;
				const tc = toolCallArgs.get(msg.toolCallId);
				// 问题块。对于 quiz，使用持久化结果里的 `details.options`——用户
				// 实际看到的真实洗牌后显示顺序——而不是原始 tool-call 参数，后者
				// 是洗牌前的作者顺序，可能与屏幕上显示的错位。ask_user_question
				// 从不洗牌，所以它的 tool-call 参数已经是真实顺序。
				if (tc) {
					const a = tc.args || {};
					const label = tc.name === "quiz" ? "测验" : "问题";
					const shuffled = msg.toolName === "quiz"
						? (msg.details?.options as Array<{ index: number; label: string }> | undefined)
						: undefined;
					const options = shuffled && shuffled.length > 0
						? shuffled.map((o) => ({ label: o.label }))
						: (Array.isArray(a.options) ? a.options : []);
					blocks.push(questionCallout(label, a.question || "", a.details?.trim() || undefined, options));
				}
				if (msg.toolName === "quiz") {
					blocks.push(answerCalloutQuiz(msg.details));
				} else {
					blocks.push(answerCalloutAsk(msg.details));
				}
				continue;
			}
		}

		if (blocks.length > 0) {
			try {
				fs.writeFileSync(logFile, blocks.join("\n\n") + "\n", "utf-8");
			} catch {
				// 忽略
			}
		}
		return count;
	}
}
