/**
 * 供 visual-tools 编写循环（mermaid_tools.ts、svg_tools.ts）使用的共享辅助：
 * 一个子进程运行器、一个每会话受管的源文件、一个精确匹配编辑器（pi-edit
 * 语义），以及把选定的渲染结果发布到 <cwd>/viz 并使用唯一文件名。
 *
 * 每个工具文件都维护自己的会话状态（在这里导入类型/辅助），这样 mermaid 和
 * svg 永远不会共享源文件。
 */

import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

// rsvg-convert 位于 MacPorts 下（/opt/local/bin）；magick/gs 位于
// /usr/local/bin；Homebrew 位于 /opt/homebrew/bin。扩充 PATH，让子 pi 进程
// （它可能继承了一个很薄的 PATH）仍然能解析它们。
export const EXTRA_PATH = ["/opt/local/bin", "/usr/local/bin", "/opt/homebrew/bin"]

// 瞬态的会话/预览文件放在 OS 临时目录（而不是 vault）下，这样只有发布后的
// PNG 才会落到 Obsidian vault 内（viz/）。
export const STAGING_ROOT = join(tmpdir(), "pi-visual-tools")
export const FILES_DIRNAME = "viz"

export const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

export function findChrome(): string | undefined {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c
  return undefined
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const augmentedPath = [...EXTRA_PATH, process.env.PATH ?? ""].join(":")
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), PATH: augmentedPath },
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs)
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolveRun({ code: null, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr, timedOut })
    })
  })
}

/** 每会话受管的源文件，每个子 pi 进程一个（按 pid 作为 key）。 */
export interface Session {
  workDir: string
  bodyPath: string
}

/** OS 临时目录下每会话的工作目录，按 pid + 组名作为 key。 */
export function sessionDir(group: string): string {
  return join(STAGING_ROOT, `${group}-${process.pid}`)
}

/** 把完整源码写到受管文件，并创建会话工作目录。 */
export function writeBody(group: string, bodyFileName: string, source: string): Session {
  const workDir = sessionDir(group)
  mkdirSync(workDir, { recursive: true })
  const bodyPath = join(workDir, bodyFileName)
  writeFileSync(bodyPath, source, "utf8")
  return { workDir, bodyPath }
}

/**
 * 在当前源码上做单次精确匹配替换，匹配 pi 内置的 edit：old_text 必须恰好
 * 出现一次。返回更新后的内容和匹配的偏移量，否则抛出一个精确的错误。
 */
export function applyEdit(current: string, oldText: string, newText: string): { updated: string; index: number } {
  if (oldText === "") throw new Error("`old_text` 必须非空。")
  if (oldText === newText) throw new Error("`old_text` 与 `new_text` 相同。")
  const first = current.indexOf(oldText)
  if (first === -1) {
    throw new Error("在当前源码中找不到 `old_text` —— 请精确匹配它。")
  }
  const second = current.indexOf(oldText, first + 1)
  if (second !== -1) {
    let n = 0
    let i = current.indexOf(oldText)
    while (i !== -1) {
      n++
      i = current.indexOf(oldText, i + oldText.length)
    }
    throw new Error(`\`old_text\` 出现了 ${n} 次 —— 请加入周围的上下文以使其唯一。`)
  }
  const updated = current.slice(0, first) + newText + current.slice(first + oldText.length)
  return { updated, index: first }
}

/** 在字符偏移 `index` 周围取一个带行号的小窗口。 */
export function snippetAround(content: string, index: number, contextLines = 3): string {
  const before = content.slice(0, index)
  const hitLine = before.split("\n").length - 1
  const lines = content.split("\n")
  const start = Math.max(0, hitLine - contextLines)
  const end = Math.min(lines.length - 1, hitLine + contextLines)
  const width = String(end + 1).length
  const out: string[] = []
  for (let i = start; i <= end; i++) out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`)
  return out.join("\n")
}

/** 把渲染出的 PNG 复制到 <cwd>/viz，使用唯一、slug 化的名字。 */
export function publish(pngPath: string, slug: string): { filename: string; path: string } {
  const filesDir = join(process.cwd(), FILES_DIRNAME)
  mkdirSync(filesDir, { recursive: true })
  const clean =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "viz"
  const filename = `viz-${clean}-${Date.now()}.png`
  const dest = join(filesDir, filename)
  copyFileSync(pngPath, dest)
  return { filename, path: dest }
}

export { basename, dirname, join, existsSync, mkdirSync, readFileSync, writeFileSync }
