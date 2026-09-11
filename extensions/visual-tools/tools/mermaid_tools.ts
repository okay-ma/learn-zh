/**
 * 供 mermaid-maker 子代理使用的 Mermaid 编写循环——三个共享一个会话作用域源
 * 文件的工具：
 *
 *   write_mermaid   —— 把完整 Mermaid 源码写到会话文件
 *   edit_mermaid    —— 在该文件上做精确匹配 old_text→new_text（pi-edit 语义）
 *   render_mermaid  —— 把文件里当前的内容渲染成 PNG，内联返回；配合
 *                      `save_as`，还能把它发布到 <cwd>/viz
 *
 * 打包在 visual-tools 扩展内，通过 interactive-subagents 的
 * `registerToolExtension` 钩子暴露给子代理（见 ../index.ts）。不是一个全局 pi
 * 扩展——由派生的子 pi 进程加载，用于任何 `tools:` frontmatter 包含这些名字的
 * 子代理（目前只有 mermaid-maker）。全部三个名字都映射到这一个文件。
 *
 * 渲染 shell 出到打包的 @mermaid-js/mermaid-cli（`mmdc`），用一个指向已安装
 * Chrome 的 puppeteer 配置，因此无需下载 Chromium。模块级会话状态在这个子进程
 * 的多次工具调用之间持续存在，并且天然与任何并行的制作者隔离（不同的进程）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { fileURLToPath } from "node:url"
import {
  applyEdit,
  dirname,
  existsSync,
  findChrome,
  join,
  mkdirSync,
  publish,
  readFileSync,
  run,
  type Session,
  snippetAround,
  writeBody,
  writeFileSync,
} from "./_common.ts"

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const EXTENSION_DIR = dirname(TOOL_DIR)
const MMDC_BIN = join(EXTENSION_DIR, "node_modules", ".bin", "mmdc")
const GROUP = "mermaid"
const BODY_FILE = "diagram.mmd"
const RENDER_TIMEOUT_MS = 120_000

type RenderDetails = { ok: boolean; path: string; filename?: string }

let session: Session | null = null

export default function mermaidToolsExtension(pi: ExtensionAPI) {
  // ── write_mermaid ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "write_mermaid",
    label: "Write Mermaid",
    description:
      "把完整的 Mermaid 源码写到本会话的受管文件（你的第一稿或一次完整重写）。" +
      "你不给文件命名——edit_mermaid 和 render_mermaid 作用在同一个文件上。\n\n" +
      "`source` 是一份完整的 Mermaid 图，例如一个 `graph TD` / `graph LR` " +
      "流程、`sequenceDiagram`、`stateDiagram-v2`、`erDiagram`、`classDiagram`、" +
      "`mindmap` 或 `timeline`。写入不渲染——准备好后再调用 render_mermaid。" +
      "对于小的修改，优先用 edit_mermaid 而不是重写。",
    parameters: Type.Object({
      source: Type.String({
        description: "完整的 Mermaid 图源码（以图类型开头，例如 `graph TD`）。",
      }),
    }),
    async execute(_id, params) {
      const source = (params.source ?? "").trim()
      if (!source) throw new Error("`write_mermaid` 需要一个非空的 `source`。")
      session = writeBody(GROUP, BODY_FILE, source)
      const lines = source.split("\n").length
      return {
        content: [
          {
            type: "text",
            text: `写入了 ${lines} 行的 Mermaid 源码。\n调用 render_mermaid 来渲染它，或调用 edit_mermaid 来微调它。`,
          },
        ],
        details: { ok: true, path: session.bodyPath, lines },
      }
    },
  })

  // ── edit_mermaid ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "edit_mermaid",
    label: "Edit Mermaid",
    description:
      "在本会话的 Mermaid 源码上做一次单次精确匹配替换——与 pi 内置 edit 相同的" +
      "契约，锁定到这一个受管文件。`old_text` 必须恰好出现一次（加入周围上下文" +
      "以保证唯一）；出现 0 次或 >1 次时调用失败且不做任何改动。请先调用 " +
      "write_mermaid。编辑不渲染。",
    parameters: Type.Object({
      old_text: Type.String({ description: "要替换的当前源码的精确子串（必须恰好匹配一次）。" }),
      new_text: Type.String({ description: "用于替换 `old_text` 的文本。" }),
    }),
    async execute(_id, params) {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error("edit_mermaid：还没有源码——请先调用 write_mermaid。")
      }
      const current = readFileSync(session.bodyPath, "utf8")
      const { updated, index } = applyEdit(current, String(params.old_text ?? ""), String(params.new_text ?? ""))
      writeFileSync(session.bodyPath, updated, "utf8")
      return {
        content: [
          { type: "text", text: "已应用编辑。更新区域：\n```\n" + snippetAround(updated, index) + "\n```\n调用 render_mermaid 来查看它。" },
        ],
        details: { ok: true, path: session.bodyPath },
      }
    },
  })

  // ── render_mermaid ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "render_mermaid",
    label: "Render Mermaid",
    description:
      "把当前的会话 Mermaid 源码渲染成 PNG 并内联返回，这样你可以看到这张图并" +
      "迭代。你不需要在这里传源码——它来自受管文件；请先调用 write_mermaid。\n\n" +
      "不带 `save_as` 自由迭代（仅预览）。当图正确且干净时，再用一个设置为短横线" +
      "主题 slug 的 `save_as` 调用一次：那会把 PNG 发布到 <cwd>/viz，使用唯一" +
      "文件名，并返回要嵌入的文件名。渲染出错时返回错误文本而不是图片——用 " +
      "edit_mermaid 修复并重新渲染。",
    parameters: Type.Object({
      save_as: Type.Optional(
        Type.String({
          description:
            "短横线主题 slug（例如 'internet-packets'）。设置后，渲染出的 PNG 会被" +
            "发布到 <cwd>/viz，名为 viz-<slug>-<timestamp>.png，并返回该文件名。" +
            "省略则只做预览渲染。",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error("render_mermaid：还没有源码——请先调用 write_mermaid。")
      }
      const { workDir, bodyPath } = session
      mkdirSync(workDir, { recursive: true })

      const chrome = findChrome()
      const cfgPath = join(workDir, "puppeteer.json")
      writeFileSync(
        cfgPath,
        JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }),
        "utf8",
      )

      const outPath = join(workDir, `render-${Date.now()}.png`)
      const res = await run(
        MMDC_BIN,
        ["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"],
        { cwd: workDir, timeoutMs: RENDER_TIMEOUT_MS, env: { PUPPETEER_SKIP_DOWNLOAD: "1" } },
      )

      if (res.code !== 0 || !existsSync(outPath)) {
        const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
        const note = res.timedOut ? "mmdc 超时。\n\n" : ""
        return {
          content: [
            {
              type: "text",
              text: `${note}Mermaid 渲染失败——没有生成图片。用 edit_mermaid 修复源码，再调用 render_mermaid。\n\n错误：\n${detail}`,
            },
          ],
          details: { ok: false, path: "" } as RenderDetails,
        }
      }

      const data = readFileSync(outPath).toString("base64")
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []

      if (params.save_as) {
        const { filename, path } = publish(outPath, String(params.save_as))
        content.push({
          type: "text",
          text: `已发布到 viz/。\nfilename: ${filename}\npath: ${path}\n\n在返回它之前，看看下面的图，确认它是正确的。`,
        })
        content.push({ type: "image", data, mimeType: "image/png" })
        return { content, details: { ok: true, path, filename } as RenderDetails }
      }

      content.push({
        type: "text",
        text: "预览渲染（尚未保存）。看：箭头/关系是否正确，标签是否对，有没有拥挤？用 edit_mermaid 修复，或用 `save_as` 重新渲染来发布。",
      })
      content.push({ type: "image", data, mimeType: "image/png" })
      return { content, details: { ok: true, path: outPath } as RenderDetails }
    },
  })
}
