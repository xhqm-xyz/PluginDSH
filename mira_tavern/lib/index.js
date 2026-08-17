/**
 * mira_tavern — DSH 主机端插件（酒馆）
 * 职责：
 *   1. 扫描并加载通用剧本 JSON（*.script.json），提供列表 / 详情 API
 *   2. 通过 webServer 提供静态资源（面板脚本 / 样式）与指令 / 状态 API
 *   3. 通过 tapIndex 把酒馆面板注入 index.html（悬浮于对话界面）
 *   4. 代理 OpenAI 兼容 /audio/speech 合成语音（可复用 llama-server 或其他服务商），
 *      支持按角色指定音色；逐幕旁白 / 台词朗读
 *   5. 注册模型可调用工具（前缀 tavern_），让模型以「导演」身份驱动演绎
 *
 * 仅依赖 Node 内置模块，不依赖任何运行时第三方包，保证链接安装时无需解析依赖。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, extname, resolve, sep, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'mira_tavern'
export const inject = ['webServer', 'tools']

// 插件根目录（本文件位于 <root>/lib/index.js）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = join(ROOT, 'assets')
const DEFAULT_SCRIPTS_DIR = join(ROOT, 'scripts')

const TTS_MAX_CHARS = 600
const SCRIPT_SUFFIX = '.script.json'

const DEFAULTS = {
  enabled: true,
  title: '酒馆',
  scriptsDir: '', // 留空使用插件 scripts/ 目录
  panel: { w: 380, h: 560 },
  position: 'right', // 'left' | 'right'
  pollIntervalMs: 1200,
  tts: {
    enabled: false, // 前端自动朗读开关（模型调用仍以 key 是否配置为准）
    provider: 'openai', // 'openai' | 'alibaba'（均可被 base 覆盖为任意 OpenAI 兼容端点）
    base: '', // 留空使用 provider 默认地址
    key: '', // 字面量 key（可选）
    keyEnv: '', // 存有 key 的环境变量名（可选）
    model: '', // 留空使用 provider 默认模型
    voice: '', // 全局默认音色，角色 voice 优先
  },
}

const TTS_PROVIDERS = {
  openai: { base: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
  alibaba: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-tts', voice: 'Chelsie' },
}

// ── 运行期状态（进程内） ────────────────────────────────────────
let cfg = structuredClone(DEFAULTS)
let scriptsDir = DEFAULT_SCRIPTS_DIR
let nextCommandId = 1
const commandQueue = []
const audioStore = new Map() // audioId -> { mime, base64 }
const scriptCache = new Map() // scriptId -> { file, script }
let clientState = null
let clientStateAt = 0
let currentScriptId = null
let currentSceneRef = 0

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
  if (commandQueue.length > 2000) commandQueue.splice(0, commandQueue.length - 2000)
  return id
}

function storeAudio(audio) {
  const audioId = String(nextCommandId) + ':a' + audioStore.size
  audioStore.set(audioId, audio)
  if (audioStore.size > 100) audioStore.delete(audioStore.keys().next().value)
  return audioId
}

// ── 剧本扫描与加载 ─────────────────────────────────────────────
async function walkFiles(dir, suffix) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walkFiles(full, suffix)))
    else if (ent.isFile() && ent.name.endsWith(suffix)) out.push(full)
  }
  return out
}

// 头像/封面等相对引用 → 可经 /tavern/data/ 访问的 URL（越界或绝对地址原样返回）
function toAssetUrl(scriptFile, ref) {
  if (!ref) return ''
  if (/^https?:\/\//i.test(ref) || ref.startsWith('/')) return ref
  const abs = resolve(dirname(scriptFile), ref)
  const rel = relative(scriptsDir, abs)
  if (rel.startsWith('..') || rel === '' || /^[a-zA-Z]:/.test(rel)) return ''
  return '/tavern/data/' + rel.split(sep).map(encodeURIComponent).join('/')
}

function normalizeScript(raw, file) {
  const characters = (Array.isArray(raw.characters) ? raw.characters : []).map((c) => {
    const ch = c && typeof c === 'object' ? c : {}
    return {
      id: String(ch.id ?? ''),
      name: String(ch.name ?? ch.id ?? ''),
      color: ch.color || '',
      voice: ch.voice || '',
      avatar: ch.avatar || '',
      avatarUrl: toAssetUrl(file, ch.avatar),
      description: ch.description || '',
    }
  })
  const narrator = raw.narrator && typeof raw.narrator === 'object'
    ? { name: String(raw.narrator.name || '旁白'), voice: raw.narrator.voice || '' }
    : { name: '旁白', voice: '' }
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).map((s) => {
    const sc = s && typeof s === 'object' ? s : {}
    return {
      id: String(sc.id ?? ''),
      title: String(sc.title ?? ''),
      stage: sc.stage || '',
      narration: sc.narration || '',
      lines: (Array.isArray(sc.lines) ? sc.lines : []).map((l) => {
        const ln = l && typeof l === 'object' ? l : {}
        return {
          speaker: String(ln.speaker ?? 'narrator'),
          text: String(ln.text ?? ''),
          action: ln.action || '',
        }
      }),
    }
  })
  return {
    schema: raw.schema || 'tavern.script/1',
    id: String(raw.id),
    title: String(raw.title || raw.id),
    subtitle: raw.subtitle || '',
    description: raw.description || '',
    narrator,
    characters,
    scenes,
  }
}

async function readScript(file) {
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.title || !Array.isArray(raw.scenes)) return null
  return normalizeScript(raw, file)
}

async function listScripts() {
  const files = await walkFiles(scriptsDir, SCRIPT_SUFFIX)
  const out = []
  for (const file of files) {
    const script = await readScript(file)
    if (!script) continue
    scriptCache.set(script.id, { file, script })
    out.push({
      id: script.id,
      title: script.title,
      subtitle: script.subtitle,
      description: script.description,
      sceneCount: script.scenes.length,
      characterCount: script.characters.length,
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

async function loadScript(id) {
  const cached = scriptCache.get(id)
  if (cached) return cached.script
  const files = await walkFiles(scriptsDir, SCRIPT_SUFFIX)
  for (const file of files) {
    const script = await readScript(file)
    if (script && script.id === id) {
      scriptCache.set(id, { file, script })
      return script
    }
  }
  return null
}

async function scriptFileOf(id) {
  const cached = scriptCache.get(id)
  if (cached) return cached.file
  const script = await loadScript(id)
  return script ? scriptCache.get(id).file : null
}

function sceneIndex(script, ref) {
  const scenes = script.scenes || []
  if (typeof ref === 'number') {
    return (ref >= 0 && ref < scenes.length) ? ref : null
  }
  const s = String(ref ?? '').trim()
  // 数字字符串按「序号（0 起）」解释，避免模型传入 "1" 被误当 scene id
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return (n >= 0 && n < scenes.length) ? n : null
  }
  const i = scenes.findIndex((sc) => sc && sc.id === s)
  return i >= 0 ? i : null
}

function characterVoice(script, speakerId) {
  if (!script) return ''
  const ch = (script.characters || []).find((c) => c.id === speakerId)
  return ch ? ch.voice || '' : ''
}

// ── TTS 合成（OpenAI 兼容 /audio/speech） ───────────────────────
function resolveTts(voiceOverride) {
  const t = cfg.tts
  const p = TTS_PROVIDERS[t.provider] || TTS_PROVIDERS.openai
  return {
    base: (t.base || p.base).replace(/\/+$/, ''),
    key: t.key || (t.keyEnv ? (process.env[t.keyEnv] || '') : ''),
    model: t.model || p.model,
    voice: voiceOverride || t.voice || p.voice,
  }
}

function hasTtsKey() {
  return Boolean(resolveTts().key)
}

async function synthTts(text, voice, signal) {
  const t = resolveTts(voice)
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
    'tavern_list_scripts',
    '列出酒馆 scripts 目录下所有可加载剧本（id、标题、简介、幕数与角色数）。',
    obj({}),
    async () => {
      const scripts = await listScripts()
      if (!scripts.length) return 'scripts 目录下没有可用剧本（需放入 *.script.json 文件）'
      return JSON.stringify(scripts, null, 2)
    },
  ))

  defs.push(textTool(
    'tavern_load_script',
    '加载指定剧本，返回元信息、角色卡与全部幕（scene）的 id 列表。',
    obj({ id: str('剧本 id（tavern_list_scripts 返回的 id）') }, ['id']),
    async (args) => {
      const script = await loadScript(args.id)
      if (!script) return '没有这个剧本：' + args.id
      currentScriptId = script.id
      currentSceneRef = 0
      return JSON.stringify({
        id: script.id,
        title: script.title,
        subtitle: script.subtitle,
        description: script.description,
        narrator: script.narrator,
        characters: script.characters,
        scenes: script.scenes.map((s) => ({ id: s.id, title: s.title })),
      }, null, 2)
    },
  ))

  defs.push(textTool(
    'tavern_get_scene',
    '读取某剧本的一幕（按序号或 scene id），返回 stage / narration / lines 全文。',
    obj({
      id: str('剧本 id（可选，缺省用当前已加载剧本）'),
      scene: str('幕的序号（0 起）或 scene id'),
    }, ['scene']),
    async (args) => {
      const script = await loadScript(args.id || currentScriptId)
      if (!script) return '没有这个剧本：' + (args.id || currentScriptId)
      const idx = sceneIndex(script, args.scene)
      if (idx === null) return '没有这一幕：' + args.scene
      return JSON.stringify({ scriptId: script.id, sceneIndex: idx, scene: script.scenes[idx] }, null, 2)
    },
  ))

  defs.push(textTool(
    'tavern_show_scene',
    '把一幕推送到前端面板显示；speak 不为 false 且已配置 TTS key 时，同时合成并朗读该幕旁白。',
    obj({
      id: str('剧本 id（可选，缺省用当前已加载剧本）'),
      scene: str('幕的序号（0 起）或 scene id'),
      speak: bool('是否朗读旁白（默认 true）'),
    }, ['scene']),
    async (args, exec) => {
      const script = await loadScript(args.id || currentScriptId)
      if (!script) return '没有这个剧本：' + (args.id || currentScriptId)
      const idx = sceneIndex(script, args.scene)
      if (idx === null) return '没有这一幕：' + args.scene
      currentScriptId = script.id
      currentSceneRef = idx
      const scene = script.scenes[idx]
      pushCommand('scene', { scriptId: script.id, sceneIndex: idx, scene })
      const wantSpeak = args.speak !== false
      if (wantSpeak && scene.narration && hasTtsKey()) {
        try {
          const audio = await synthTts(scene.narration, script.narrator.voice, exec.signal)
          pushCommand('speak', { text: scene.narration, speaker: 'narrator', audioId: storeAudio(audio) })
        } catch (e) {
          return '已显示第 ' + idx + ' 幕，但旁白朗读失败：' + e.message
        }
      }
      return '已显示第 ' + idx + ' 幕《' + (scene.title || scene.id) + '》' + (scene.narration ? '（旁白：' + scene.narration.slice(0, 40) + '…）' : '')
    },
  ))

  defs.push(textTool(
    'tavern_speak',
    '用指定音色合成一句台词并推送到前端朗读（不改变当前幕）。speaker 填角色 id 可自动套用其音色。',
    obj({
      text: str('要朗读的文字'),
      speaker: str('说话人（可选：角色 id / narrator / 任意名字）'),
      voice: str('音色覆盖（可选，缺省用角色或全局默认）'),
    }, ['text']),
    async (args, exec) => {
      const script = await loadScript(currentScriptId)
      const voice = args.voice || characterVoice(script, args.speaker) || (args.speaker === 'narrator' && script ? script.narrator.voice : '')
      if (!hasTtsKey()) {
        pushCommand('speak', { text: args.text, speaker: args.speaker || 'narrator' })
        return '未配置 TTS key，仅显示文字（不发声）'
      }
      const audio = await synthTts(args.text, voice, exec.signal)
      pushCommand('speak', { text: args.text, speaker: args.speaker || 'narrator', audioId: storeAudio(audio) })
      return '已朗读：' + String(args.text).slice(0, 60)
    },
  ))

  defs.push(textTool(
    'tavern_next',
    '让前端面板前进到下一幕（若在末幕则无动作）。',
    obj({}),
    async () => {
      pushCommand('next', true)
      return '已下发「下一幕」指令'
    },
  ))

  defs.push(textTool(
    'tavern_prev',
    '让前端面板回退到上一幕。',
    obj({}),
    async () => {
      pushCommand('prev', true)
      return '已下发「上一幕」指令'
    },
  ))

  defs.push(textTool(
    'tavern_get_state',
    '获取酒馆当前状态：在线与否、显隐、已加载剧本、当前幕、TTS 是否就绪、可用剧本列表。',
    obj({}),
    async () => {
      const scripts = await listScripts()
      const base = {
        online: clientState !== null,
        serverKnown: {
          enabled: cfg.enabled,
          currentScriptId,
          currentSceneRef,
          ttsReady: hasTtsKey(),
          ttsProvider: cfg.tts.provider,
          scriptsAvailable: scripts.map((s) => s.id),
        },
      }
      if (clientState === null) {
        return JSON.stringify({ ...base, note: '浏览器尚未打开酒馆面板（没有加载任何会话页面的 widget）' }, null, 2)
      }
      return JSON.stringify({ ...base, client: clientState, lastSeenMsAgo: Date.now() - clientStateAt }, null, 2)
    },
  ))

  defs.push(textTool(
    'tavern_show',
    '显示酒馆面板。',
    obj({}),
    async () => {
      pushCommand('show', true)
      return '已显示酒馆'
    },
  ))

  defs.push(textTool(
    'tavern_hide',
    '隐藏酒馆面板。',
    obj({}),
    async () => {
      pushCommand('hide', true)
      return '已隐藏酒馆'
    },
  ))

  defs.push(textTool(
    'tavern_get_config',
    '获取插件当前配置（TTS key 只返回是否已配置，不回传明文）。',
    obj({}),
    async () => {
      const view = structuredClone(cfg)
      if (view.tts) {
        view.tts.keyConfigured = hasTtsKey()
        delete view.tts.key
      }
      view.scriptsDir = scriptsDir
      view.scripts = (await listScripts()).map((s) => s.id)
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
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' })
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
    send(res, 200, buf, type)
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8')
  }
}

async function handleApi(pathname, req, res) {
  const sub = pathname.slice('/tavern/api/'.length)

  if (sub === 'config' && req.method === 'GET') {
    return sendJson(res, 200, {
      enabled: cfg.enabled,
      title: cfg.title,
      panel: cfg.panel,
      position: cfg.position,
      pollIntervalMs: cfg.pollIntervalMs,
      tts: { enabled: cfg.tts.enabled, ready: hasTtsKey() },
    })
  }

  if (sub === 'scripts' && req.method === 'GET') {
    return sendJson(res, 200, { scripts: await listScripts() })
  }

  if (sub === 'script' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x')
    const id = url.searchParams.get('id') || ''
    const script = await loadScript(id)
    if (!script) return sendJson(res, 404, { error: '没有这个剧本：' + id })
    return sendJson(res, 200, { script })
  }

  if (sub === 'commands' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x')
    const since = Number(url.searchParams.get('since') || 0)
    return sendJson(res, 200, { commands: commandQueue.filter((c) => c.id > since) })
  }

  if (sub === 'command-result' && req.method === 'POST') {
    await readBody(req)
    return sendJson(res, 200, { ok: true })
  }

  if (sub === 'state' && req.method === 'POST') {
    const body = await readBody(req)
    if (body && typeof body === 'object') {
      clientState = body
      clientStateAt = Date.now()
      if (typeof body.scriptId === 'string') currentScriptId = body.scriptId
      if (typeof body.sceneIndex === 'number') currentSceneRef = body.sceneIndex
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
      const audio = await synthTts(body.text || '', body.voice || '')
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

  if (pathname.startsWith('/tavern/api/')) return handleApi(pathname, req, res)
  if (pathname.startsWith('/tavern/assets/')) return serveStaticFrom(ASSETS_DIR, pathname.slice('/tavern/assets/'.length), res)
  if (pathname.startsWith('/tavern/data/')) return serveStaticFrom(scriptsDir, pathname.slice('/tavern/data/'.length), res)
  send(res, 404, 'not found', 'text/plain; charset=utf-8')
}

const INJECTED_ASSETS = [
  '<link rel="stylesheet" href="/tavern/assets/css/tavern.css">',
  '<script defer src="/tavern/assets/js/tavern.js"></script>',
].join('\n')

function tapIndex(html) {
  if (html.includes('/tavern/assets/js/tavern.js')) return html
  if (html.includes('</head>')) return html.replace('</head>', INJECTED_ASSETS + '\n</head>')
  if (html.includes('<head>')) return html.replace('<head>', '<head>\n' + INJECTED_ASSETS)
  return INJECTED_ASSETS + '\n' + html
}

// ── 插件入口 ───────────────────────────────────────────────────
export function apply(ctx, config) {
  cfg = deepMerge(structuredClone(DEFAULTS), config || {})
  scriptsDir = cfg.scriptsDir ? resolve(cfg.scriptsDir) : DEFAULT_SCRIPTS_DIR

  if (cfg.enabled === false) return

  // 1. 注入面板脚本到 index.html
  ctx.effect(() => ctx.webServer.tapIndex(tapIndex))

  // 2. 注册静态资源 / 剧本数据 / API 路由
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/tavern', handler: handleRoute }))

  // 3. 注册模型可调用工具
  registerTools(ctx)
}
