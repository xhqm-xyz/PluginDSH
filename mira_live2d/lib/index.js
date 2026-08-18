/**
 * mira_live2d — DSH 主机端插件
 * 职责：
 *   1. 注册模型可调用的 MCP 风格工具（ctx.tools）
 *   2. 通过 webServer 提供静态资源（widget 脚本、Live2D 运行库、模型文件）与指令/状态 API
 *   3. 通过 tapIndex 把看板娘脚本注入 index.html（每个会话的对话界面都会出现）
 *   4. 代理 OpenAI / 阿里云 TTS，合成语音并推送「说话 + 气泡」指令
 *   5. 监听 agent 状态（思考 / 等待确认 / 空闲），推送表情 mood 指令
 *
 * 仅依赖 Node 内置模块，不依赖任何运行时第三方包，保证链接安装时无需解析依赖。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, extname, resolve, sep, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'mira_live2d'
export const inject = ['webServer', 'tools']

// 插件根目录（本文件位于 <root>/lib/index.js）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = join(ROOT, 'assets')
const DEFAULT_MODEL_DIR = join(ROOT, 'model')

const TTS_MAX_CHARS = 600

const DEFAULTS = {
  enabled: true,
  model: '',
  modelsDir: '',
  canvas: { w: 480, h: 630 },
  position: 'right', // 'left' | 'right'
  mobileScale: 55,
  showHint: true,
  pollIntervalMs: 1500,
  tts: {
    enabled: false,
    provider: 'openai', // 'openai' | 'alibaba'
    base: '', // 留空使用 provider 默认地址
    key: '', // 字面量 key（可选）
    keyEnv: '', // 存有 key 的环境变量名（可选）
    model: '', // 留空使用 provider 默认模型
    voice: '', // 留空使用 provider 默认音色
  },
  persona: {
    thinking: { expression: '', bubble: '' },
    awaiting: { expression: '', bubble: '' },
    idleClearMs: 3200,
  },
}

const TTS_PROVIDERS = {
  openai: { base: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
  alibaba: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-tts', voice: 'Chelsie' },
}

// 运行期状态（进程内）
let cfg = structuredClone(DEFAULTS)
let modelDir = DEFAULT_MODEL_DIR
// 用时间戳作指令 ID 起点：服务器重启后指令 ID 仍保持递增，
// 避免客户端持久化的游标（since）大于新指令 ID 而漏收指令。
let nextCommandId = Date.now() * 1000
const commandQueue = []
const audioStore = new Map() // audioId -> { mime, base64 }
let clientState = null
let clientStateAt = 0
let personaAtRuntime = structuredClone(DEFAULTS.persona)

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch
  }
  const out = { ...base }
  for (const key of Object.keys(patch)) {
    out[key] = deepMerge(base[key], patch[key])
  }
  return out
}

function pushCommand(action, value) {
  const id = nextCommandId++
  commandQueue.push({ id, action, value, ts: Date.now() })
  // 防止队列无限增长
  if (commandQueue.length > 2000) commandQueue.splice(0, commandQueue.length - 2000)
  return id
}

// ── 模型目录扫描 ────────────────────────────────────────────────
async function listModels() {
  const out = []
  let entries
  try {
    entries = await readdir(modelDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = join(modelDir, ent.name)
    let files
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    const model3 = files.find((f) => f.endsWith('.model3.json'))
    if (model3) out.push({ name: ent.name, entry: ent.name + '/' + model3 })
  }
  return out
}

async function resolveModelEntry(modelName) {
  const models = await listModels()
  const hit = models.find((m) => m.name === modelName)
  return hit ? hit.entry : null
}

// ── 模型能力解析（表情 / 动作清单） ─────────────────────────────
async function readModelCapabilities(modelName) {
  const models = await listModels()
  const hit = models.find((m) => m.name === modelName)
  if (!hit) return null
  const safe = normalize(hit.entry).replace(/\\/g, '/')
  const full = resolve(modelDir, ...safe.split('/'))
  if (!full.startsWith(resolve(modelDir) + sep)) return null
  let json
  try {
    json = JSON.parse(await readFile(full, 'utf8'))
  } catch (e) {
    return { error: 'model3.json 读取失败：' + e.message }
  }
  const expressions = (json.FileReferences?.Expressions || []).map((x) => x.Name).filter(Boolean)
  const motions = Object.keys(json.FileReferences?.Motions || {})
  return { expressions, motions }
}

// ── TTS 合成（OpenAI 兼容 /audio/speech） ───────────────────────
function resolveTts() {
  const t = cfg.tts
  const p = TTS_PROVIDERS[t.provider] || TTS_PROVIDERS.openai
  return {
    base: (t.base || p.base).replace(/\/+$/, ''),
    key: t.key || (t.keyEnv ? (process.env[t.keyEnv] || '') : ''),
    model: t.model || p.model,
    voice: t.voice || p.voice,
  }
}

async function synthTts(text, signal) {
  const t = resolveTts()
  if (!t.key) throw new Error('未配置 TTS key（tts.key 或 tts.keyEnv）')
  const input = String(text || '').slice(0, TTS_MAX_CHARS)
  if (!input.trim()) throw new Error('朗读文本为空')
  const resp = await fetch(t.base + '/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + t.key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: t.model, input, voice: t.voice, response_format: 'mp3' }),
    signal,
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error('TTS 接口返回 ' + resp.status + ' ' + detail.slice(0, 300))
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  return { mime: 'audio/mpeg', base64: buf.toString('base64') }
}

// ── 工具注册 ───────────────────────────────────────────────────
function textTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (e) {
        return '(错误：' + (e && e.message ? e.message : String(e)) + ')'
      }
    },
  }
}

function obj(props, required = []) {
  return { type: 'object', properties: props, required }
}
function str(description) {
  return { type: 'string', description }
}
function bool(description) {
  return { type: 'boolean', description }
}
function num(description) {
  return { type: 'number', description }
}

function registerTools(ctx) {
  const defs = []

  defs.push(textTool(
    'mira_get_state',
    '获取看板娘当前状态：在线与否、可见/隐藏、当前模型、当前表情、当前动作、当前气泡语句、表情列表、动作列表、表情/动画开关、思考等待配置、可切换模型列表等。',
    obj({}),
    async () => {
      const models = await listModels()
      const base = {
        online: clientState !== null,
        serverKnown: {
          enabled: cfg.enabled,
          configuredModel: cfg.model,
          modelsAvailable: models.map((m) => m.name),
          ttsEnabled: !!cfg.tts.enabled,
          ttsProvider: cfg.tts.provider,
          persona: personaAtRuntime,
        },
      }
      if (clientState === null) {
        return JSON.stringify({ ...base, note: '浏览器尚未连上看板娘（没有打开任何会话页面，或 widget 未加载）' }, null, 2)
      }
      return JSON.stringify({ ...base, client: clientState, lastSeenMsAgo: Date.now() - clientStateAt }, null, 2)
    },
  ))

  defs.push(textTool(
    'mira_list_models',
    '列出插件 model 文件夹下的所有可切换模型（含模型名与入口 model3.json 相对路径）。',
    obj({}),
    async () => {
      const models = await listModels()
      if (!models.length) return 'model 文件夹下没有可用模型（需要放入含 *.model3.json 的子目录）'
      return JSON.stringify(models, null, 2)
    },
  ))

  defs.push(textTool(
    'mira_get_model_capabilities',
    '解析指定模型的 model3.json，返回表情列表与动作组列表。',
    obj({ model: str('模型名（mira_list_models 返回的 name）') }, ['model']),
    async (args) => {
      const caps = await readModelCapabilities(args.model)
      if (!caps) return '没有这个模型：' + args.model
      if (caps.error) return caps.error
      return JSON.stringify(caps, null, 2)
    },
  ))

  defs.push(textTool(
    'mira_switch_model',
    '切换看板娘展示的模型（须是 model 文件夹下已存在的模型）。',
    obj({ model: str('模型名（mira_list_models 返回的 name）') }, ['model']),
    async (args) => {
      const entry = await resolveModelEntry(args.model)
      if (!entry) return '没有这个模型：' + args.model + '（可用：' + (await listModels()).map((m) => m.name).join('、') + '）'
      pushCommand('switch_model', { model: args.model, entry })
      return '已下发切换模型指令：' + args.model
    },
  ))

  defs.push(textTool(
    'mira_set_expression',
    '切换看板娘表情；传空字符串恢复默认表情。stack=true 时作为叠加表情开关（可多个叠加并存），否则互斥替换。',
    obj({
      expression: str('表情名（空串恢复默认）'),
      stack: bool('true=叠加开关（可多个并存）；false=互斥替换（默认）'),
    }),
    async (args) => {
      pushCommand('expression', { name: args.expression ?? '', stack: !!args.stack })
      const nm = args.expression ?? ''
      return nm === '' ? '已恢复默认表情' : '已下发表情' + (args.stack ? '叠加切换' : '切换') + '：' + nm
    },
  ))

  defs.push(textTool(
    'mira_play_motion',
    '播放看板娘动作组。',
    obj({ motion: str('动作组名（mira_get_model_capabilities 返回的 motions）') }, ['motion']),
    async (args) => {
      pushCommand('motion', args.motion)
      return '已下发动作播放：' + args.motion
    },
  ))

  defs.push(textTool(
    'mira_speak',
    '让看板娘说话：调用已配置的 TTS（OpenAI 或阿里云百炼）合成语音，同时用气泡展示文字。',
    obj({ text: str('要朗读并显示的文字') }, ['text']),
    async (args, exec) => {
      if (!cfg.tts.enabled && !resolveTts().key) {
        pushCommand('bubble', args.text)
        return '未启用/未配置 TTS，仅展示气泡（不发声）'
      }
      const audio = await synthTts(args.text, exec.signal)
      const audioId = String(nextCommandId) + ':a' + audioStore.size
      audioStore.set(audioId, audio)
      if (audioStore.size > 100) audioStore.delete(audioStore.keys().next().value)
      pushCommand('speak', { text: String(args.text).slice(0, TTS_MAX_CHARS), audioId })
      return '已合成语音并下发说话 + 气泡指令'
    },
  ))

  defs.push(textTool(
    'mira_bubble',
    '让看板娘用气泡显示文字（不朗读）。',
    obj({ text: str('气泡文字') }, ['text']),
    async (args) => {
      pushCommand('bubble', String(args.text).slice(0, 600))
      return '已下发气泡显示'
    },
  ))

  defs.push(textTool(
    'mira_show',
    '显示看板娘。',
    obj({}),
    async () => {
      pushCommand('show', true)
      return '已显示'
    },
  ))

  defs.push(textTool(
    'mira_hide',
    '隐藏看板娘。',
    obj({}),
    async () => {
      pushCommand('hide', true)
      return '已隐藏'
    },
  ))

  defs.push(textTool(
    'mira_set_expressions_enabled',
    '打开或关闭表情系统（关闭后不再响应表情切换）。',
    obj({ enabled: bool('true 打开 / false 关闭') }, ['enabled']),
    async (args) => {
      pushCommand('set_expressions', !!args.enabled)
      return (args.enabled ? '已打开' : '已关闭') + '表情系统'
    },
  ))

  defs.push(textTool(
    'mira_set_animations_enabled',
    '打开或关闭动作/动画播放。',
    obj({ enabled: bool('true 打开 / false 关闭') }, ['enabled']),
    async (args) => {
      pushCommand('set_animations', !!args.enabled)
      return (args.enabled ? '已打开' : '已关闭') + '动画播放'
    },
  ))

  defs.push(textTool(
    'mira_set_mood',
    '手动设置看板娘情绪状态：thinking（思考）/ awaiting（等待确认）/ idle（空闲默认）。',
    obj({ mood: str("thinking / awaiting / idle") }, ['mood']),
    async (args) => {
      const m = String(args.mood)
      if (!['thinking', 'awaiting', 'idle'].includes(m)) return 'mood 只能是 thinking / awaiting / idle'
      pushCommand('mood', m)
      return '已设置 mood：' + m
    },
  ))

  defs.push(textTool(
    'mira_set_persona',
    '设置思考与等待时的表情和气泡（空串表示不设置/清除该表情），以及空闲后表情清除的延迟毫秒数。',
    obj({
      thinkingExpression: str('思考时表情（空串=不设）'),
      thinkingBubble: str('思考时气泡文字（空串=不显示）'),
      awaitingExpression: str('等待确认时表情（空串=不设）'),
      awaitingBubble: str('等待确认时气泡文字（空串=不显示）'),
      idleClearMs: num('空闲多少毫秒后清除表情/气泡，默认 3200'),
    }),
    async (args) => {
      personaAtRuntime = {
        thinking: { expression: args.thinkingExpression ?? '', bubble: args.thinkingBubble ?? '' },
        awaiting: { expression: args.awaitingExpression ?? '', bubble: args.awaitingBubble ?? '' },
        idleClearMs: typeof args.idleClearMs === 'number' ? args.idleClearMs : (cfg.persona.idleClearMs ?? 3200),
      }
      pushCommand('set_persona', personaAtRuntime)
      return '已更新思考/等待表情配置'
    },
  ))

  defs.push(textTool(
    'mira_get_config',
    '获取插件当前配置（TTS key 只返回是否已配置，不回传明文）。',
    obj({}),
    async () => {
      const view = structuredClone(cfg)
      if (view.tts) {
        view.tts.keyConfigured = !!resolveTts().key
        delete view.tts.key
      }
      view.modelsDir = modelDir
      view.models = (await listModels()).map((m) => m.name)
      return JSON.stringify(view, null, 2)
    },
  ))

  const disposers = defs.map((d) => ctx.tools.register(d))
  ctx.effect(() => () => disposers.forEach((d) => d()))
}

// ── 静态文件 / API 路由 ────────────────────────────────────────
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mtn': 'application/octet-stream',
  '.fnt': 'application/octet-stream',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolveBody) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolveBody(raw ? JSON.parse(raw) : {})
      } catch {
        resolveBody({})
      }
    })
    req.on('error', () => resolveBody({}))
  })
}

async function serveStaticFrom(root, relPath, res) {
  const rootAbs = resolve(root)
  const full = resolve(rootAbs, ...normalize(relPath).split(/[\\/]+/))
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    send(res, 403, 'forbidden', 'text/plain; charset=utf-8')
    return
  }
  try {
    const buf = await readFile(full)
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
    res.end(buf)
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8')
  }
}

async function handleApi(pathname, req, res) {
  const sub = pathname.slice('/live2d/api/'.length)

  if (sub === 'config' && req.method === 'GET') {
    const models = await listModels()
    const modelEntry = cfg.model ? await resolveModelEntry(cfg.model) : null
    return sendJson(res, 200, {
      enabled: cfg.enabled,
      model: cfg.model,
      modelEntry,
      models,
      canvas: cfg.canvas,
      position: cfg.position,
      mobileScale: cfg.mobileScale,
      showHint: cfg.showHint,
      pollIntervalMs: cfg.pollIntervalMs,
      tts: { enabled: cfg.tts.enabled },
      persona: personaAtRuntime,
    })
  }

  if (sub === 'commands' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x')
    const since = Number(url.searchParams.get('since') || 0)
    const list = commandQueue.filter((c) => c.id > since)
    return sendJson(res, 200, { commands: list })
  }

  if (sub === 'command-result' && req.method === 'POST') {
    // 结果仅用于日志（当前未记录），消费请求体避免连接挂起
    await readBody(req)
    return sendJson(res, 200, { ok: true })
  }

  if (sub === 'state' && req.method === 'POST') {
    const body = await readBody(req)
    if (body && typeof body === 'object') {
      clientState = body
      clientStateAt = Date.now()
    }
    return sendJson(res, 200, { ok: true })
  }

  if (sub.startsWith('audio/') && req.method === 'GET') {
    const id = sub.slice('audio/'.length)
    const audio = audioStore.get(id)
    if (!audio) return send(res, 404, 'not found', 'text/plain; charset=utf-8')
    return sendJson(res, 200, audio)
  }

  if (sub === 'tts' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const audio = await synthTts(body.text || '')
      return sendJson(res, 200, audio)
    } catch (e) {
      return sendJson(res, 500, { error: e.message })
    }
  }

  send(res, 404, 'not found', 'text/plain; charset=utf-8')
}

async function handleRoute(req, res) {
  const url = new URL(req.url, 'http://x')
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    pathname = url.pathname
  }

  if (pathname.startsWith('/live2d/api/')) {
    return handleApi(pathname, req, res)
  }
  if (pathname.startsWith('/live2d/assets/')) {
    return serveStaticFrom(ASSETS_DIR, pathname.slice('/live2d/assets/'.length), res)
  }
  if (pathname.startsWith('/live2d/models/')) {
    return serveStaticFrom(modelDir, pathname.slice('/live2d/models/'.length), res)
  }
  send(res, 404, 'not found', 'text/plain; charset=utf-8')
}

const INJECTED_ASSETS = [
  '<link rel="stylesheet" href="/live2d/assets/css/widget.css">',
  '<script defer src="/live2d/assets/lib/live2dcubismcore.min.js"></script>',
  '<script defer src="/live2d/assets/lib/pixi.min.js"></script>',
  '<script defer src="/live2d/assets/lib/cubism4.min.js"></script>',
  '<script defer src="/live2d/assets/js/widget.js"></script>',
].join('\n')

function tapIndex(html) {
  if (html.includes('/live2d/assets/js/widget.js')) return html
  if (html.includes('</head>')) return html.replace('</head>', INJECTED_ASSETS + '\n</head>')
  if (html.includes('<head>')) return html.replace('<head>', '<head>\n' + INJECTED_ASSETS)
  return INJECTED_ASSETS + '\n' + html
}

// ── 插件入口 ───────────────────────────────────────────────────
export function apply(ctx, config) {
  cfg = deepMerge(structuredClone(DEFAULTS), config || {})
  modelDir = cfg.modelsDir ? resolve(cfg.modelsDir) : DEFAULT_MODEL_DIR
  personaAtRuntime = structuredClone(cfg.persona)

  if (cfg.enabled === false) return

  // 1. 注入看板娘脚本到 index.html
  ctx.effect(() => ctx.webServer.tapIndex(tapIndex))

  // 2. 注册静态资源 / 模型 / API 路由
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/live2d', handler: handleRoute }))

  // 3. 注册模型可调用的工具
  registerTools(ctx)

  // 4. 思考 / 等待 / 空闲 表情联动（agent 状态 → mood 指令）
  ctx.on('agent/status', (payload) => {
    if (!payload || !payload.status) return
    if (payload.status === 'running') pushCommand('mood', 'thinking')
    else if (payload.status === 'idle') pushCommand('mood', 'idle')
  })

  // 模型调用 ask_user_question 后 → 等待用户确认
  ctx.on('tools/result', (exec) => {
    if (exec && exec.name === 'ask_user_question') pushCommand('mood', 'awaiting')
  })
}
