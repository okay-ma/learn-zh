/**
 * 供 svg-maker 子代理使用的 SVG 编写循环——三个共享一个会话作用域源文件的工具：
 *
 *   write_svg   —— 把完整 SVG 源码写到会话文件
 *   edit_svg    —— 在该文件上做精确匹配 old_text→new_text（pi-edit 语义）
 *   render_svg  —— 把文件里当前的内容渲染成 PNG，内联返回；配合
 *                  `save_as`，还能把它发布到 <cwd>/viz
 *
 * 打包在 visual-tools 扩展内，通过 interactive-subagents 的
 * `registerToolExtension` 钩子暴露给子代理（见 ../index.ts）。由派生的子 pi
 * 进程加载，用于任何 `tools:` frontmatter 包含这些名字的子代理（目前只有
 * svg-maker）。全部三个名字都映射到这一个文件。
 *
 * 渲染 shell 出到 rsvg-convert（librsvg——对系统字体处理良好），如果
 * rsvg-convert 缺失则回退到 ImageMagick 的 `magick`。两者都是系统二进制，
 * 无 node 渲染依赖。模块级会话状态在这个子进程的多次工具调用之间持续存在，
 * 与任何并行的制作者隔离。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import {
  applyEdit,
  existsSync,
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

const GROUP = "svg"
const BODY_FILE = "diagram.svg"
const RENDER_TIMEOUT_MS = 60_000

type RenderDetails = { ok: boolean; path: string; filename?: string }

let session: Session | null = null

/** 通过 rsvg-convert 把 SVG 文件渲染成 PNG，失败则回退到 magick。 */
async function renderSvg(svgPath: string, outPath: string, workDir: string) {
  // rsvg-convert 以 SVG 的固有尺寸渲染；-z 2 将其放大两倍以获得清晰度。
  let res = await run("rsvg-convert", ["-z", "2", svgPath, "-o", outPath], {
    cwd: workDir,
    timeoutMs: RENDER_TIMEOUT_MS,
  })
  if (res.code === 0 && existsSync(outPath)) return { ok: true as const, res }
  // 回退：ImageMagick。-density 192（约为 96dpi 的 2 倍）以获得清晰的光栅图。
  const magick = await run("magick", ["-density", "192", "-background", "white", svgPath, outPath], {
    cwd: workDir,
    timeoutMs: RENDER_TIMEOUT_MS,
  })
  if (magick.code === 0 && existsSync(outPath)) return { ok: true as const, res: magick }
  return { ok: false as const, res: res.code !== null ? res : magick }
}

export default function svgToolsExtension(pi: ExtensionAPI) {
  // ── write_svg ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "write_svg",
    label: "Write SVG",
    description:
      "把完整的 SVG 源码写到本会话的受管文件（你的第一稿或一次完整重写）。" +
      "你不给文件命名——edit_svg 和 render_svg 作用在同一个文件上。\n\n" +
      "`source` 是一个完整的 `<svg ...>…</svg>` 文档，带显式的 width/height（或 " +
      "viewBox）、可读的字号，以及浅色或透明背景。写入不渲染——准备好后再调用 " +
      "render_svg。对于小的修改，优先用 edit_svg 而不是重写。",
    parameters: Type.Object({
      source: Type.String({ description: "完整的 SVG 文档，从 `<svg` 到 `</svg>`。" }),
    }),
    async execute(_id, params) {
      const source = (params.source ?? "").trim()
      if (!source) throw new Error("`write_svg` 需要一个非空的 `source`。")
      if (!source.includes("<svg")) throw new Error("`write_svg`：source 必须是一个完整的 <svg>…</svg> 文档。")
      session = writeBody(GROUP, BODY_FILE, source)
      const lines = source.split("\n").length
      return {
        content: [
          { type: "text", text: `写入了 ${lines} 行的 SVG 源码。\n调用 render_svg 来渲染它，或调用 edit_svg 来微调它。` },
        ],
        details: { ok: true, path: session.bodyPath, lines },
      }
    },
  })

  // ── edit_svg ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "edit_svg",
    label: "Edit SVG",
    description:
      "在本会话的 SVG 源码上做一次单次精确匹配替换——与 pi 内置 edit 相同的" +
      "契约，锁定到这一个受管文件。`old_text` 必须恰好出现一次（加入周围上下文" +
      "以保证唯一）；出现 0 次或 >1 次时调用失败且不做任何改动。请先调用 " +
      "write_svg。编辑不渲染。",
    parameters: Type.Object({
      old_text: Type.String({ description: "要替换的当前源码的精确子串（必须恰好匹配一次）。" }),
      new_text: Type.String({ description: "用于替换 `old_text` 的文本。" }),
    }),
    async execute(_id, params) {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error("edit_svg：还没有源码——请先调用 write_svg。")
      }
      const current = readFileSync(session.bodyPath, "utf8")
      const { updated, index } = applyEdit(current, String(params.old_text ?? ""), String(params.new_text ?? ""))
      writeFileSync(session.bodyPath, updated, "utf8")
      return {
        content: [
          { type: "text", text: "已应用编辑。更新区域：\n```\n" + snippetAround(updated, index) + "\n```\n调用 render_svg 来查看它。" },
        ],
        details: { ok: true, path: session.bodyPath },
      }
    },
  })

  // ── render_svg ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "render_svg",
    label: "Render SVG",
    description:
      "把当前的会话 SVG 源码渲染成 PNG 并内联返回，这样你可以看到这张图并迭代。" +
      "你不需要在这里传源码——它来自受管文件；请先调用 write_svg。\n\n" +
      "不带 `save_as` 自由迭代（仅预览）。当图正确且干净时，再用一个设置为短横线" +
      "主题 slug 的 `save_as` 调用一次：那会把 PNG 发布到 <cwd>/viz，使用唯一" +
      "文件名，并返回要嵌入的文件名。渲染出错时返回错误文本而不是图片——用 " +
      "edit_svg 修复并重新渲染。",
    parameters: Type.Object({
      save_as: Type.Optional(
        Type.String({
          description:
            "短横线主题 slug（例如 'number-line'）。设置后，渲染出的 PNG 会被发布" +
            "到 <cwd>/viz，名为 viz-<slug>-<timestamp>.png，并返回该文件名。" +
            "省略则只做预览渲染。",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error("render_svg：还没有源码——请先调用 write_svg。")
      }
      const { workDir, bodyPath } = session
      mkdirSync(workDir, { recursive: true })

      const outPath = join(workDir, `render-${Date.now()}.png`)
      const { ok, res } = await renderSvg(bodyPath, outPath, workDir)

      if (!ok) {
        const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
        const note = res.timedOut ? "SVG 渲染超时。\n\n" : ""
        return {
          content: [
            {
              type: "text",
              text: `${note}SVG 渲染失败——没有生成图片（尝试了 rsvg-convert 然后 magick）。用 edit_svg 修复源码，再调用 render_svg。\n\n错误：\n${detail}`,
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
          text: `已发布到 viz/。\nfilename: ${filename}\npath: ${path}\n\n在返回它之前，看看下面的图，确认几何是正确的。`,
        })
        content.push({ type: "image", data, mimeType: "image/png" })
        return { content, details: { ok: true, path, filename } as RenderDetails }
      }

      content.push({
        type: "text",
        text: "预览渲染（尚未保存）。看：坐标、角度、方向和比例是否正确？标签清楚且未被裁切吗？用 edit_svg 修复，或用 `save_as` 重新渲染来发布。",
      })
      content.push({ type: "image", data, mimeType: "image/png" })
      return { content, details: { ok: true, path: outPath } as RenderDetails }
    },
  })
}
