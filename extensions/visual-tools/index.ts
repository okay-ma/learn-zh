/**
 * visual-tools
 *
 * 一个自包含的 pi 扩展，它把自定义子代理工具注册到全局加载的
 * `interactive-subagents` 扩展上——并且不做任何别的事：
 *
 *   • write_mermaid / edit_mermaid / render_mermaid
 *       (tools/mermaid_tools.ts) —— mermaid-maker 的编写循环：写一份
 *       Mermaid 源码，精确匹配地编辑它，把受管文件里当前的内容渲染成
 *       PNG（经由打包的 @mermaid-js/mermaid-cli 和一个已安装的 Chrome），
 *       把 PNG 内联返回以供检查，并且——当给定 `save_as` 时——把它发布到
 *       <cwd>/viz，使用唯一名称。
 *   • write_svg / edit_svg / render_svg
 *       (tools/svg_tools.ts) —— svg-maker 的编写循环：同样的形态，但通过
 *       rsvg-convert 把手写 SVG 渲染成 PNG（回退：magick）。
 *
 * 每个三件套都映射到同一个文件，这样 interactive-subagents 只需加载它一次，
 * 就能把全部三个名字加入允许列表。
 *
 * ── 注册如何到达 interactive-subagents ─────────────────────────────────────
 * 全局的 `interactive-subagents` 扩展在 `globalThis.__pi_interactive_subagents`
 * 上暴露了 `registerToolExtension`。一个子代理以 `--no-extensions` 外加一个
 * 显式的 `-e <path>` 启动，只针对它知道 name → path 映射的工具；本扩展让它
 * 认识上面这六个名字，于是 mermaid-maker / svg-maker（它们在自己的 `tools:`
 * frontmatter 里列出了这些名字）就能把它们加载进自己的子进程。
 *
 * pi 先加载项目本地扩展（本扩展）再加载全局扩展，所以当这个工厂运行时，
 * `globalThis.__pi_interactive_subagents` 还不存在。我们把注册推迟到
 * `session_start`，它会在每个扩展的工厂都运行完之后触发一次。注册是幂等的
 * （相同的 name+path 是 no-op），所以 `/reload` 或 "reload"/"new"/"resume"
 * 的 session_start 都是无害的。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url))
const MERMAID_TOOLS = path.join(EXT_DIR, "tools", "mermaid_tools.ts")
const SVG_TOOLS = path.join(EXT_DIR, "tools", "svg_tools.ts")

interface InteractiveSubagentsApi {
  registerToolExtension: (name: string, extensionPath: string) => void
}

function registerToolExtensions(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (globalThis as any).__pi_interactive_subagents as InteractiveSubagentsApi | undefined
  if (!api?.registerToolExtension) return // interactive-subagents 未加载——no-op

  for (const [name, toolPath] of [
    ["write_mermaid", MERMAID_TOOLS],
    ["edit_mermaid", MERMAID_TOOLS],
    ["render_mermaid", MERMAID_TOOLS],
    ["write_svg", SVG_TOOLS],
    ["edit_svg", SVG_TOOLS],
    ["render_svg", SVG_TOOLS],
  ] as const) {
    if (!fs.existsSync(toolPath)) continue
    try {
      api.registerToolExtension(name, toolPath)
    } catch {
      // 已在另一个路径下注册过，或重复注册——忽略。
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    registerToolExtensions()
  })
}
