#!/usr/bin/env node
/**
 * dsh-buddy installer — 给任意 dsh 宿主换上 CodeBuddy 大脑。
 *
 * 用法:
 *   node install.mjs [--host <dsh bin.js 路径 | dsh 包目录 | 源码仓库根>]
 *
 * 不带 --host 时按以下顺序自动探测:
 *   1) cwd 下 source 仓库布局: <cwd>/apps/cli/lib/bin.js
 *   2) cwd 能解析到 npm 包 @deepseek-ai/dsh
 *
 * 做四件事:
 *   1. 定位宿主解析基座（npm 树或源码 monorepo），逐包解析 6 个 peer 依赖真实路径
 *   2. 在本插件目录建 node_modules 链接（Windows junction / POSIX symlink）→ 与宿主同源，cordis 单例有保障
 *   3. 确保 @tencent-ai/agent-sdk 可解析（不可解析则 npm install）
 *   4. 生成本目录 buddy.patch.yml（patch 相对锚定本目录）+ 全量自检 + 打印点火命令
 */
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)

/** 插件直接 import 的宿主侧依赖（peer，由宿主树提供）。 */
const HOST_DEPS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/schemastery',
]

const log = (...a) => console.log(...a)
const warn = (...a) => console.warn('⚠ ', ...a)
const die = (msg) => {
  console.error('✗ ' + msg)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * 1. 定位宿主
 * ------------------------------------------------------------------ */

function detectHost(explicit) {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.resolve(process.cwd(), 'apps/cli/lib/bin.js')]

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && c.endsWith('bin.js')) {
      return { kind: 'source', hostDir: path.dirname(c), binJs: c }
    }
  }

  // npm 包: 从 cwd 上溯解析 @deepseek-ai/dsh
  try {
    const pkgJson = require_.resolve('@deepseek-ai/dsh/package.json', { paths: [process.cwd()] })
    const pkgDir = path.dirname(pkgJson)
    const binJs = path.join(pkgDir, 'lib', 'bin.js')
    if (!fs.existsSync(binJs)) die(`npm 包 @deepseek-ai/dsh 存在但缺产物 ${binJs}，安装可能不完整`)
    return { kind: 'npm', hostDir: pkgDir, binJs }
  } catch {
    /* fallthrough */
  }

  die(
    '未能定位 dsh 宿主。请用 --host 指定:\n' +
      '  source 版: --host <仓库>/apps/cli/lib/bin.js\n' +
      '  npm 版:    --host <…>/node_modules/@deepseek-ai/dsh/lib/bin.js',
  )
}

/** 从宿主目录向上找 monorepo 根（pnpm-workspace.yaml 标记）。 */
function findRepoRoot(fromDir) {
  let d = fromDir
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d
    const parent = path.dirname(d)
    if (parent === d) return undefined
    d = parent
  }
  return undefined
}

/** 在 monorepo 源码树里按包名扫 workspace 包（兜底 pnpm 顶层没提升的包，如 dsh-scope）。 */
function scanWorkspaceFor(repoRoot, pkgName) {
  const patterns = ['packages', 'vendor', 'apps']
  for (const top of patterns) {
    const topDir = path.join(repoRoot, top)
    if (!fs.existsSync(topDir)) continue
    for (const a of fs.readdirSync(topDir)) {
      const level1 = path.join(topDir, a)
      const level2 = fs.existsSync(level1) && fs.statSync(level1).isDirectory() ? fs.readdirSync(level1) : []
      for (const b of [...level2, '.']) {
        const pj = path.join(level1, b, 'package.json')
        if (b === '.' && !fs.existsSync(pj)) continue
        try {
          if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === pkgName) return path.dirname(pj)
        } catch {
          /* 目录无 package.json，跳过（幽灵目录） */
        }
      }
    }
  }
  return undefined
}

/** 解析宿主侧每个 peer 依赖的真实路径。 */
function resolveHostDeps(hostDir) {
  const repoRoot = findRepoRoot(hostDir)
  const resolved = {}
  for (const dep of HOST_DEPS) {
    let dir
    try {
      dir = path.dirname(require_.resolve(dep + '/package.json', { paths: [hostDir] }))
    } catch {
      if (repoRoot) dir = scanWorkspaceFor(repoRoot, dep)
      if (!dir) die(`宿主缺少依赖 ${dep}——确认 dsh 安装/构建完整后再试`)
      log(`  ${dep} → workspace 兜底命中: ${path.relative(repoRoot, dir)}`)
    }
    resolved[dep] = fs.realpathSync(dir)
  }
  return resolved
}

/* ------------------------------------------------------------------ *
 * 2. 建链接（与宿主同源 → cordis/schemastery 全局单例有保障）
 * ------------------------------------------------------------------ */

function linkDir(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  if (process.platform === 'win32') {
    // junction：不需要管理员权限，目录级透明解析
    fs.symlinkSync(target, linkPath, 'junction')
  } else {
    fs.symlinkSync(target, linkPath, 'dir')
  }
}

function buildLinks(hostDeps) {
  const nm = path.join(PLUGIN_DIR, 'node_modules')
  if (fs.existsSync(nm)) {
    // 只可能是我们上次生成的内容，整目录重建
    fs.rmSync(nm, { recursive: true, force: true })
  }
  for (const [dep, realDir] of Object.entries(hostDeps)) {
    linkDir(realDir, path.join(nm, dep))
    log(`  ${dep} ✓`)
  }
  return nm
}

/* ------------------------------------------------------------------ *
 * 3. agent-sdk（插件唯一私有依赖）
 * ------------------------------------------------------------------ */

function ensureSdk() {
  try {
    const r = require_.resolve('@tencent-ai/agent-sdk', { paths: [PLUGIN_DIR] })
    log(`  @tencent-ai/agent-sdk ✓（已有: ${path.dirname(r)}）`)
    return
  } catch {
    /* 需要安装 */
  }
  log('  安装 @tencent-ai/agent-sdk …')
  execSync('npm install --no-audit --no-fund', { cwd: PLUGIN_DIR, stdio: 'inherit' })
}

/* ------------------------------------------------------------------ *
 * 4. patch 生成 + 自检 + 点火命令
 * ------------------------------------------------------------------ */

const PATCH_BODY = `# dsh-buddy overlay — 用 CodeBuddy 替换 dsh 默认 agent-loop。
# 由 install.mjs 自动生成；语义详见 README「原理」一节。
#
# 关键点：
#   - patch 不能换名（name mismatch 整行静默 skip），所以禁用旧行 + insert 新行
#   - name 用 ./ 相对路径：loader 会把它锚定为相对本 patch 文件的绝对路径
#     （裸包名的解析锚点在 profile 目录，跨树必炸）

# 1. 原生 DeepSeek 驱动器下岗
- id: agent-loop
  disabled: true

# 2. CodeBuddy 驱动器上岗（服务名同为 agentLoop，消费者无感）
- insert:
    - id: buddy-loop
      name: ./lib/index.js
      config:
        buddyMaxTurns: 30
        agents: []

# 3. pi-ai 依赖闭包巨大且休眠，不挂载
- id: llm-pi-ai
  disabled: true

# 4. 会话标题生成走 DeepSeek 适配器，没 key 只会报错噪音
- id: session-title-llm
  disabled: true
`

function writePatch() {
  const p = path.join(PLUGIN_DIR, 'buddy.patch.yml')
  fs.writeFileSync(p, PATCH_BODY)
  return p
}

function verify(host, hostDeps) {
  const problems = []
  const ok = (msg) => log('  ✓ ' + msg)

  // a) cordis 单例：宿主与插件必须解析到同一真实文件
  const hostCordis = fs.realpathSync(
    require_.resolve('@deepseek-ai/cordis', { paths: [host.hostDir] }),
  )
  const plugCordis = fs.realpathSync(
    require_.resolve('@deepseek-ai/cordis', { paths: [PLUGIN_DIR + '/lib'] }),
  )
  if (hostCordis === plugCordis) ok(`cordis 单例保障（${hostCordis}）`)
  else problems.push(`cordis 双实例！宿主=${hostCordis} 插件=${plugCordis}`)

  // b) 宿主 base patch 的三行目标仍在（禁用/禁用的行必须可寻址）
  const repoRoot = findRepoRoot(host.hostDir)
  const basePatchCandidates = [
    ...(repoRoot ? [path.join(repoRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml')] : []), // source
    path.join(host.hostDir, '..', 'dsh-base', 'cordis.patch.yml'), // npm（@deepseek-ai/dsh-base）
  ]
  const basePatch = basePatchCandidates.find((p) => fs.existsSync(p))
  if (!basePatch) {
    warn('找不到宿主 base cordis.patch.yml，跳过 patch 目标行核验（通常无碍）')
  } else {
    const text = fs.readFileSync(basePatch, 'utf8')
    for (const row of ['agent-loop', 'llm-pi-ai', 'session-title-llm']) {
      if (text.includes(`id: ${row}`)) ok(`宿主 patch 目标行 "${row}" 存在`)
      else problems.push(`宿主 base patch 缺少目标行 "${row}"——宿主版本可能不兼容，提 issue`)
    }
  }

  // c) codebuddy CLI 登录态
  try {
    const v = execSync('codebuddy --version', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    ok(`codebuddy CLI 可用（${v.split('\n')[0]}）`)
  } catch {
    problems.push('codebuddy CLI 不可用——请先安装并登录（SDK 复用其登录态扣腾讯积分）')
  }

  // d) 遥控器浏览器 half（dsh.client 双面声明 + client bundle）
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
  const clientRel = manifest?.exports?.['./client']
  const clientDecl = manifest?.dsh?.client
  if (clientRel && clientDecl?.platform === 'web' && fs.existsSync(path.join(PLUGIN_DIR, clientRel))) {
    ok(`遥控器面板就绪（${clientRel}，注入 ${clientDecl.inject?.join(', ') || '无'}）`)
  } else {
    problems.push('遥控器浏览器 half 缺失——package.json 缺少 exports["./client"] 或 dsh.client 声明，或 lib/client.js 不存在')
  }

  return problems
}

/* ------------------------------------------------------------------ */

const host = detectHost(process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : undefined)
log(`\n== dsh-buddy 换心安装器 ==`)
log(`宿主: ${host.kind} 版 @deepseek-ai/dsh`)
log(`  ${host.binJs}\n`)

log('[1/4] 解析宿主侧 peer 依赖')
const hostDeps = resolveHostDeps(host.hostDir)

log('\n[2/4] 建立插件依赖链接（与宿主同源）')
buildLinks(hostDeps)

log('\n[3/4] 确保 agent-sdk')
ensureSdk()

log('\n[4/4] 生成 patch 并自检')
const patchFile = writePatch()
log(`  ${patchFile}`)
const problems = verify(host, hostDeps)

if (problems.length) {
  console.error('\n自检未全过：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(2)
}

log(`
== 安装完成，点火命令 ==

  # 可选：把会话圈在自定义目录（默认用 ~/.dsh 也行）
  $env:DSH_HOME = "<你的会话目录>"          # PowerShell
  export DSH_HOME=<你的会话目录>            # bash/zsh

  node "${host.binJs}" web --patch "${patchFile}" --port 3210

启动后浏览器打开 http://127.0.0.1:3210，发消息应由 CodeBuddy 回答
（无 MISSING_CREDENTIAL 红字；usage 走腾讯积分）。

遥控器：设置页（齿轮）里找「CodeBuddy 遥控器」分区，可调 model /
thinking / maxTurns / cwd / env / systemPrompt，保存后对新会话生效。
配置落盘在本包目录的 buddy-config.json（含 env 时注意保密）。
`)
