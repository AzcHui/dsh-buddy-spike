#!/usr/bin/env node
/**
 * dsh-buddy 自检工具（可选，手动运行：node install.mjs）。
 *
 * 自从迁移为标准 bundle（package.json 声明 dsh.bundle.patch）后，安装本身
 * 只需一条官方命令，本脚本不再参与安装，只做启动前体检并打印安装指引：
 *
 *   dsh plugin --profile <name> add ./dsh-buddy   # 在本目录的父目录执行
 *   dsh --profile <name>                          # 或 dsh web（= --profile web）
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const problems = []
const ok = (msg) => console.log('  ✓ ' + msg)

console.log('\n[dsh-buddy] 自检\n')

// a) 关键文件齐全
for (const f of ['lib/index.js', 'lib/agent.js', 'lib/config.js', 'lib/client.js', 'cordis.patch.yml']) {
  if (existsSync(join(HERE, f))) ok(f)
  else problems.push(`缺文件 ${f}——包可能不完整，请重新获取`)
}

// b) bundle 声明与 patch 行正确
try {
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  if (pkg.dsh?.bundle?.patch === './cordis.patch.yml') ok('dsh.bundle 声明正确')
  else problems.push('package.json 缺少 dsh.bundle.patch 声明，dsh 不会把它当组合包激活')
  if (pkg.dsh?.client?.platform === 'web') ok('遥控器 dsh.client 声明在位')
  else problems.push('package.json 缺少 dsh.client 声明，设置页不会出现遥控器面板')
} catch (e) {
  problems.push('package.json 不可读: ' + e.message)
}

try {
  const yml = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
  if (/name:\s*dsh-buddy\b/.test(yml)) ok('patch 行用裸包名 name: dsh-buddy（profile 内可解析）')
  else problems.push('cordis.patch.yml 的 insert 行应为裸包名 name: dsh-buddy')
  if (/id:\s*agent-loop[\s\S]*?disabled:\s*true/.test(yml)) ok('原生 agent-loop 已禁用')
  else problems.push('cordis.patch.yml 缺少对 agent-loop 的禁用行——换心不生效')
} catch (e) {
  problems.push('cordis.patch.yml 不可读: ' + e.message)
}

// c) codebuddy CLI 登录态（SDK 复用其登录扣腾讯积分）
try {
  const v = execSync('codebuddy --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  ok(`codebuddy CLI 可用（${v.split('\n')[0]}）`)
} catch {
  problems.push('codebuddy CLI 不可用——请先安装并登录')
}

// d) 外挂依赖自持：agent-sdk 必须在本包 node_modules（link: 安装语义下
//    pnpm 不装目标依赖，且 ESM 沿链接路径解析够不到上层 node_modules）
if (existsSync(join(HERE, 'node_modules', '@tencent-ai', 'agent-sdk', 'package.json'))) {
  ok('agent-sdk 自持在位（node_modules/@tencent-ai/agent-sdk）')
} else {
  problems.push('缺 node_modules/@tencent-ai/agent-sdk —— 在本包目录执行 npm install --omit=dev')
}

console.log('')
if (problems.length) {
  console.error('自检未通过：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(2)
}

console.log(`== 自检通过，安装命令 ==

  # 在本包的父目录（dsh-buddy-spike/）执行；pnpm 需在 PATH 上
  dsh plugin --profile web add ./dsh-buddy     # profile 名按需换成你自己的

  # 启动（--patch 时代结束了，不再需要）
  dsh web          # = dsh --profile web
  # 或指定 profile：dsh --profile <name>

  # 不启动、只验层：
  dsh --profile web --dump-config   # 应看到 "# == dsh-buddy" 层
`)
