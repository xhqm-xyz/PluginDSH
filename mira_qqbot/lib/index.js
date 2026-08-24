/**
 * mira_qqbot — DSH 主机端插件（接管本机个人 QQ）
 *
 * 职责：
 *   1. 通过 OneBot v11 正向 WebSocket 连接 NapCat（跑在本机 QQ 客户端里），
 *      自动重连 + 心跳保活；
 *   2. 把 QQ 的收/发消息、好友、群、群成员、频道等能力封装成模型可调用的
 *      MCP 风格工具（前缀 qq_，通过 ctx.tools 注册）；
 *   3. 把收到的消息缓冲在进程内环形队列，模型用 qq_recv_messages 增量拉取，
 *      从而实现「接管」：既能主动发，也能收到并应答。
 *
 * 仅依赖 Node 内置能力（全局 fetch / WebSocket / fs / path / url），
 * 保证以 link 方式装入 profile 时无需解析第三方依赖。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'

export const name = 'mira_qqbot'
export const inject = ['tools', 'agents', 'workspaceRegistry']

// 插件根目录（本文件位于 <root>/lib/index.js）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  enabled: true,
  // OneBot v11 正向 WebSocket 地址（NapCat WebUI → 网络配置 → WebSocket 服务）
  wsUrl: 'ws://127.0.0.1:3001',
  // OneBot access_token（与 NapCat 里配的 token 一致；留空表示无鉴权）
  accessToken: '',
  reconnectMinMs: 2000,
  reconnectMaxMs: 60000,
  callTimeoutMs: 8000,
  bufferSize: 500,
  // ── 自动应答模式（事件驱动，收到消息自动唤醒回复） ──────────
  // 每个聊天对象（私聊按 QQ 号、群聊按群号）一个独立会话；
  // 收到 newCommand 消息即重置该对象的会话。enabled 为 false 时完全关闭。
  autoReply: {
    enabled: false,
    // 人设提示词；留空使用预设自带人设
    personaPrompt: '',
    // 行为规则提示词（数组，每条一条规则）；留空使用内置默认规则
    rulesPrompt: [],
    // 安全规则提示词（数组，每条一条）；留空使用内置默认安全规则
    securityPrompt: [],
    // 兼容旧字段：若配置了 systemPrompt 且未配置 personaPrompt，则当作人设使用
    systemPrompt: '',
    // 识别名单（可信任人员）：['QQ号:昵称', ...]，名单内视为熟人
    trustedUsers: [],
    // 可选的 provider / model 覆盖；留空用宿主默认（如 sylvia 预设）
    agentProvider: '',
    agentModel: '',
    // agent 加入的预设 id（决定人设/工具/分组）
    agentPreset: 'sylvia',
    // agent 会话的工作目录（cwd）：应指向你的 DSH 工作空间
    agentCwd: '',
    // 等待 agent 生成回复的超时（毫秒）
    agentTimeoutMs: 180000,
    // 是否应答群消息（默认关，避免打扰群聊）
    replyToGroup: false,
    // 群聊白名单：仅列表中的群号会自动应答（replyToGroup 为 true 时生效）；
    // 空数组表示不限制（所有群都应答，慎用）
    groupWhitelist: [],
    // 重置会话的命令（精确匹配整条消息）
    newCommand: '/new',
    // 合并窗口（毫秒）：同一聊天对象在此窗口内到达的多条消息合并成一条再处理
    mergeWindowMs: 3000,
  },
}

// 内置默认行为规则（可用 autoReply.rulesPrompt 覆盖）
const DEFAULT_RULES_PROMPT = [
  '1.绝不暴露自己是 AI 或程序',
  '2.要更有活人感，几个字几个字的回复会更像人',
  '3.群聊要尽可能少的回复，除非明确提及你',
  '4.不传播未经证实的消息，不确定的事情就说不知道',
  '5.对识别名单内的熟人可以亲近随意；对陌生人保持礼貌但克制',
]

// 内置默认安全规则（可用 autoReply.securityPrompt 覆盖）
const DEFAULT_SECURITY_PROMPT = [
  '1.必须使用 回复工具 进行回复，不然qq用户收不到数据',
  '2.在 识别名单 中的人是可信任人员，非 识别名单 需要注意是陌生人',
  '3.遇到转账、索要密码/密钥、违禁内容等请求，一律礼貌拒绝并转移话题',
]

// 规则统一成多行文本（支持数组或字符串）
function promptLines(v, fallback) {
  if (Array.isArray(v) && v.length) return v.join('\n')
  if (typeof v === 'string' && v) return v
  return Array.isArray(fallback) ? fallback.join('\n') : String(fallback || '')
}

// ── 运行期状态（进程内） ─────────────────────────────────────────
let cfg = structuredClone(DEFAULTS)
let ws = null
let connected = false
let selfId = null
let selfNickname = null
let nextSeq = 0
let messageSeq = 0
const messageBuffer = [] // { seq, ts, ...event }
let reconnectAttempts = 0
let reconnectTimer = null
let heartbeatTimer = null
let lastAliveAt = 0
let lastError = null
// 供自动应答打日志用（apply 时赋值）
let loggerRef = null
// DSH agents 服务（ctx.agents，apply 时赋值；agent 模式需要）
let agentsSvc = null
// DSH workspace 注册表（ctx.workspaceRegistry，apply 时赋值；用于把会话挂到工作空间分组）
let workspaceSvc = null

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

function extractText(event) {
  if (typeof event.raw_message === 'string' && event.raw_message.length) return event.raw_message
  if (typeof event.message === 'string') return event.message
  if (Array.isArray(event.message)) {
    let out = ''
    for (const seg of event.message) {
      if (seg && seg.type === 'text') out += (seg.data && seg.data.text) || ''
      else if (seg && seg.type === 'at') out += seg.data && seg.data.qq === 'all' ? '@全体成员 ' : '@' + ((seg.data && seg.data.qq) || '') + ' '
      else if (seg && seg.type === 'image') out += '[图片]'
      else if (seg && seg.type === 'face') out += '[表情]'
      else if (seg && seg.type === 'record') out += '[语音]'
      else if (seg && seg.type === 'video') out += '[视频]'
      else if (seg && seg.type === 'file') out += '[文件]'
      else if (seg) out += '[CQ:' + seg.type + ']'
    }
    return out.trim()
  }
  return ''
}

// 取转发消息体：优先用已内嵌的 content，否则调 get_forward_msg
async function fetchForwardMessages(seg) {
  let msgs = Array.isArray(seg.data.content) ? seg.data.content : null
  if ((!msgs || msgs.length === 0) && seg.data.id) {
    try {
      const r = await call('get_forward_msg', { id: String(seg.data.id) })
      msgs = (r && Array.isArray(r.messages)) ? r.messages : []
    } catch {
      msgs = []
    }
  }
  return msgs || []
}

// 递归提取单条消息的文本（含嵌套转发），depth 防止无限递归
async function extractMessageTextRecursive(m, depth) {
  const segs = Array.isArray(m.message) ? m.message : []
  let out = ''
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text') out += (seg.data && seg.data.text) || ''
    else if (seg.type === 'at') out += seg.data && seg.data.qq === 'all' ? '@全体成员 ' : '@' + ((seg.data && seg.data.qq) || '') + ' '
    else if (seg.type === 'image') out += '[图片]'
    else if (seg.type === 'face') out += '[表情]'
    else if (seg.type === 'record') out += '[语音]'
    else if (seg.type === 'video') out += '[视频]'
    else if (seg.type === 'file') out += '[文件' + ((seg.data && seg.data.file) ? '：' + seg.data.file : '') + ']'
    else if (seg.type === 'forward' && seg.data) {
      // 嵌套转发：优先用响应里已内嵌的 content，否则才调 get_forward_msg
      if (depth >= 3) {
        out += '[转发消息（嵌套过深，已省略）]'
      } else {
        const msgs = await fetchForwardMessages(seg)
        if (!msgs.length) {
          out += '[转发内容获取失败]'
        } else {
          const inner = []
          for (const im of msgs) {
            const nick = (im.sender && (im.sender.card || im.sender.nickname)) || String(im.user_id || '')
            const txt = await extractMessageTextRecursive(im, depth + 1)
            inner.push((nick ? nick + '：' : '') + txt)
          }
          out += '[转发消息]\n' + inner.join('\n')
        }
      }
    } else if (seg) {
      out += '[CQ:' + seg.type + ']'
    }
  }
  return out.trim()
}

// 转发消息（CQ:forward）：递归提取内容（含嵌套转发），返回多行文本
async function extractForwardContent(data) {
  const segs = Array.isArray(data.message) ? data.message : []
  const parts = []
  for (const seg of segs) {
    if (seg && seg.type === 'forward' && seg.data) {
      try {
        const msgs = await fetchForwardMessages(seg)
        for (const m of msgs) {
          const nick = (m.sender && (m.sender.card || m.sender.nickname)) || String(m.user_id || '')
          const txt = await extractMessageTextRecursive(m, 0)
          parts.push((nick ? nick + '：' : '') + txt)
        }
      } catch (e) {
        parts.push('[转发内容获取失败：' + (e && e.message ? e.message : String(e)) + ']')
      }
    }
  }
  return parts.join('\n')
}

// ── OneBot 连接管理 ──────────────────────────────────────────────
function clearTimers() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(
    cfg.reconnectMinMs * Math.pow(2, reconnectAttempts),
    cfg.reconnectMaxMs,
  )
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectAttempts++
    connect()
  }, delay)
}

function connect() {
  clearTimers()
  if (ws) {
    try { ws.close() } catch { /* noop */ }
    ws = null
  }
  connected = false

  if (!cfg.wsUrl) {
    lastError = '未配置 wsUrl'
    return
  }

  const headers = cfg.accessToken ? { Authorization: 'Bearer ' + cfg.accessToken } : {}

  let sock
  try {
    sock = new WebSocket(cfg.wsUrl, { headers })
  } catch (e) {
    lastError = 'WebSocket 构造失败：' + (e && e.message ? e.message : String(e))
    scheduleReconnect()
    return
  }
  ws = sock

  sock.addEventListener('open', () => {
    connected = true
    reconnectAttempts = 0
    lastAliveAt = Date.now()
    lastError = null
    // 连接后主动拉一次自身信息，顺便确认鉴权是否通过
    call('get_login_info', {}, 6000)
      .then((data) => {
        if (data) {
          selfId = data.user_id ?? data.uin ?? selfId
          selfNickname = data.nickname ?? selfNickname
        }
      })
      .catch(() => { /* 忽略 */ })
    // 每 30s 检查一次活性（NapCat 会推 heartbeat meta_event，据此判定僵尸连接）
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastAliveAt > 90000) {
        lastError = '心跳超时，强制重连'
        try { sock.close() } catch { /* noop */ }
      }
    }, 30000)
  })

  sock.addEventListener('message', (ev) => {
    lastAliveAt = Date.now()
    let data
    try {
      data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return

    // 有 echo 的是 API 响应，交给 call 的监听器处理
    if (data.echo !== undefined) return

    const pt = data.post_type
    if (pt === 'meta_event') {
      if (data.meta_event_type === 'lifecycle' && data.sub_type === 'connect' && data.self_id) {
        selfId = data.self_id
      }
      return
    }
    if (pt === 'message') {
      messageSeq++
      messageBuffer.push({
        seq: messageSeq,
        ts: Date.now(),
        post_type: data.post_type,
        message_type: data.message_type,
        sub_type: data.sub_type,
        message_id: data.message_id,
        user_id: data.user_id,
        group_id: data.group_id,
        guild_id: data.guild_id,
        channel_id: data.channel_id,
        sender: data.sender,
        raw: extractText(data),
        raw_message: data.raw_message,
        time: data.time,
      })
      if (messageBuffer.length > cfg.bufferSize) {
        messageBuffer.splice(0, messageBuffer.length - cfg.bufferSize)
      }
      // 自动应答：事件驱动，收到消息即自动唤醒处理（不阻塞缓冲）
      if (cfg.autoReply.enabled) {
        handleAutoReply(data).catch((e) => {
          lastError = '自动回复异常：' + (e && e.message ? e.message : String(e))
        })
      }
    }
  })

  sock.addEventListener('close', () => {
    connected = false
    ws = null
    scheduleReconnect()
  })

  sock.addEventListener('error', (e) => {
    lastError = 'WebSocket 错误' + (e && e.message ? '：' + e.message : '')
    // close 事件会随后触发，统一走重连
  })
}

// 带 echo 的 API 调用（返回 Promise<data>）
function call(action, params, timeoutMs) {
  return new Promise((resolveCall, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error('未连接 OneBot（NapCat 未运行或未登录）'))
      return
    }
    const echo = 'qq' + Math.random().toString(36).slice(2, 12) + Date.now()
    const handler = (ev) => {
      let resp
      try {
        resp = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      } catch {
        return
      }
      if (resp && resp.echo === echo) {
        ws.removeEventListener('message', handler)
        clearTimeout(timer)
        const ok = resp.status === 'ok' || resp.retcode === 0
        if (ok) resolveCall(resp.data)
        else reject(new Error(resp.msg || resp.message || ('retcode ' + resp.retcode)))
      }
    }
    ws.addEventListener('message', handler)
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error('OneBot 调用超时（' + action + '）'))
    }, timeoutMs || cfg.callTimeoutMs)
    try {
      ws.send(JSON.stringify({ action, params, echo }))
    } catch (e) {
      ws.removeEventListener('message', handler)
      clearTimeout(timer)
      reject(e)
    }
  })
}

// ── 自动应答：DSH agent 会话 + 队列 ────────────────────────────
// 处理中标记：chatId -> Promise，防止同一会话并发触发
const sessionBusy = new Map()
// chatId -> 待处理消息队列（同一会话严格串行）
const agentQueue = new Map()
// 合并窗口：chatId -> { items: [{data,text}], timer }
const pendingMerge = new Map()

// 把合并窗口内积累的多条消息合并成一条，交给后续处理
function flushMerged(chatId) {
  const p = pendingMerge.get(chatId)
  if (!p) return
  pendingMerge.delete(chatId)
  if (p.timer) clearTimeout(p.timer)
  const text = p.items.map((i) => i.text).join('\n')
  const data = p.items[0].data
  processMerged(chatId, data, text)
}

// ── DSH agent 机制：每个聊天对象 = 一个独立 dsh 会话 ────────────
// chatId -> { agent, sessionId }
const agentSessions = new Map()
// 数据目录：统一放在 agentCwd/data 下（存 meta.json 与 files/），不存在则新建
function dataDir() {
  const cwd = cfg.autoReply && cfg.autoReply.agentCwd
  if (!cwd) return null
  const dir = resolve(String(cwd), 'data')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  return dir
}
// 维护 chatId -> sessionId 映射（持久化用）
function metaFile() {
  const d = dataDir()
  return d ? resolve(d, 'meta.json') : null
}
// meta.json 读写锁：不同聊天对象并发新建会话时，串行化 read-modify-write，
// 避免“后写覆盖先写”把刚建立的绑定又冲掉（重启后绑定丢失的根因之一）。
let metaLock = Promise.resolve()
function withMetaLock(fn) {
  const run = metaLock.then(fn, fn)
  metaLock = run.catch(() => {})
  return run
}
function loadAgentMeta() {
  const f = metaFile()
  if (!f) return {}
  try { return JSON.parse(readFileSync(f, 'utf8')) || {} } catch { return {} }
}
function saveAgentMeta(meta) {
  const f = metaFile()
  if (!f) return
  try {
    mkdirSync(resolve(f, '..'), { recursive: true })
    // 原子写：先写临时文件再 rename，避免进程中途退出留下半截 meta.json
    const tmp = f + '.tmp'
    writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch (e) {
    loggerRef?.warn?.('[mira_qqbot] 保存 agent 会话映射失败：' + (e && e.message ? e.message : String(e)))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// agent 加入预设的 setup：缺少 preset 时工具/提示词/技能为空层且装配报错。
// 同时注入聊天规则（rulesPrompt，用户配置或内置默认）与可选的自定义人设
// （personaPrompt 仅显式配置时注入，否则沿用预设自带人设）。
function presetSetup(agentCtx) {
  const ar = cfg.autoReply || {}
  const presets = agentCtx.get && agentCtx.get('agentPresets')
  const presetId = ar.agentPreset || 'sylvia'
  const mount = presets ? Promise.resolve(presets.mount(agentCtx, presetId)) : Promise.resolve()
  return mount.then(() => {
    const sp = agentCtx.systemPrompt
    if (sp && typeof sp.section === 'function') {
      const rules = promptLines(ar.rulesPrompt, DEFAULT_RULES_PROMPT)
      // 规则放最前（order 最小）+ 强化措辞，确保模型遵守
      sp.section({
        name: 'mira_qqbot:rules',
        order: -100,
        text: '【聊天规则（必须严格遵守，最高优先级）】\n' + rules + '\n\n请确保你的每一次回复都符合以上规则。',
      })
      const persona = ar.personaPrompt || ar.systemPrompt
      if (persona) sp.section({ name: 'mira_qqbot:persona', order: 0, text: '【人设】\n' + persona })
    }
    return undefined
  })
}

// 会话标题（界面显示用）：用户名+QQ号 / 群名+群号
function sessionTitleFor(data) {
  const isGroup = data.message_type === 'group'
  if (isGroup) {
    const name = (data.sender && (data.sender.card || data.sender.nickname)) || '群聊'
    return name + '(' + data.group_id + ')'
  }
  const name = (data.sender && (data.sender.nickname || data.sender.card)) || String(data.user_id)
  return name + '(' + data.user_id + ')'
}

// 确保会话已有标题（没有则写入 session/title 事件）
function ensureSessionTitle(agent, title) {
  if (!agent || !agent.session || !title) return
  try {
    const hasTitle = agent.session.events.some((e) => e.type === 'session/title')
    if (!hasTitle) agent.session.append('session/title', { title })
  } catch (e) {
    loggerRef?.warn?.('[mira_qqbot] 设置会话标题失败：' + (e && e.message ? e.message : String(e)))
  }
}

// 确保会话记录 preset 归属（写入 agent-preset/selected 事件，GUI 按预设分组显示）
function ensureAgentPresetRecord(agent) {
  const presetId = (cfg.autoReply && cfg.autoReply.agentPreset) || 'sylvia'
  if (!agent || !agent.session || !presetId) return
  try {
    const has = agent.session.events.some((e) => e.type === 'agent-preset/selected')
    if (!has) agent.session.append('agent-preset/selected', { agentPreset: presetId })
  } catch (e) {
    loggerRef?.warn?.('[mira_qqbot] 写入 preset 归属失败：' + (e && e.message ? e.message : String(e)))
  }
}

// 把会话挂到匹配的工作空间（cwd 对应的 workspace），否则界面归「未分组」
async function attachToWorkspace(sessionId, cwd) {
  if (!workspaceSvc || !cwd || !sessionId) return
  try {
    const ws = await workspaceSvc.resolveByPath(cwd)
    if (ws) {
      await ws.attachSession(sessionId)
      loggerRef?.info?.('[mira_qqbot] 会话 ' + sessionId + ' 已挂到工作空间 ' + ws.path)
    } else {
      loggerRef?.warn?.('[mira_qqbot] 工作空间 ' + cwd + ' 尚未注册，会话将显示在「未分组」（请在 DSH 界面新建该工作空间，或检查 agentCwd 配置）')
    }
  } catch (e) {
    loggerRef?.warn?.('[mira_qqbot] 挂载工作空间失败 ' + sessionId + '：' + (e && e.message ? e.message : String(e)))
  }
}

async function ensureAgent(chatId, title) {
  const ar = cfg.autoReply
  const svc = agentsSvc
  if (!svc) throw new Error('DSH agents 服务不可用，无法使用 agent 模式')
  const existing = agentSessions.get(chatId)
  if (existing && existing.agent) return existing.agent
  const presetId = ar.agentPreset || 'sylvia'
  // provider/model 选项（create 与 resume 都需要，否则 agent 无模型可用）
  const agentOptions = {}
  if (ar.agentProvider) agentOptions.provider = ar.agentProvider
  if (ar.agentModel) agentOptions.model = ar.agentModel
  if (!ar.agentProvider && !ar.agentModel) {
    loggerRef?.warn?.('[mira_qqbot] agent 模式未配置 agentProvider/agentModel，会报 "has no provider/model"，请参考宿主默认模型配置')
  }

  let agent = null
  let sessionId = ''

  // ── 恢复持久化会话（重启后从磁盘恢复） ──
  // 「while it is live」= 会话已被某个 live agent 占用（旧实例残留 / 并发 / 框架自动恢复）。
  // 此时优先复用该 live agent（svc.get 直接取现成的），而不是新建——这是根治，等待只是兜底。
  // get 不到（说明正在退休的短暂窗口）才退避重试；其他错误（损坏/不存在）一次失败即降级。
  const snapshot = loadAgentMeta()
  const persistedId = snapshot[chatId]
  if (persistedId) {
    const resumeDelays = [0, 500, 1000, 2000]
    for (let attempt = 0; attempt < resumeDelays.length && !agent; attempt++) {
      if (attempt > 0) await sleep(resumeDelays[attempt])
      try {
        const h = await svc.resume({
          resumeSessionId: persistedId,
          ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
          setup: presetSetup,
        })
        agent = h && h.agent
        if (!agent) throw new Error('resume 未返回 agent')
        sessionId = persistedId
        ensureSessionTitle(agent, title)
        ensureAgentPresetRecord(agent)
        await attachToWorkspace(sessionId, ar.agentCwd)
        loggerRef?.info?.('[mira_qqbot] 已恢复 agent 会话 ' + sessionId + '（' + chatId + '）')
        break
      } catch (e) {
        const msg = e && e.message ? e.message : String(e)
        const live = /while it is live/i.test(msg)
        if (live) {
          // 会话已 live：直接复用现有 agent，不新建、不丢绑定
          const liveAgent = typeof svc.get === 'function' ? svc.get(persistedId) : undefined
          if (liveAgent) {
            agent = liveAgent
            sessionId = persistedId
            ensureSessionTitle(agent, title)
            ensureAgentPresetRecord(agent)
            await attachToWorkspace(sessionId, ar.agentCwd)
            loggerRef?.info?.('[mira_qqbot] 复用 live 会话 ' + sessionId + '（' + chatId + '）')
            break
          }
        }
        const detail = e && e.stack ? e.stack : String(e)
        const isLast = attempt === resumeDelays.length - 1
        if (isLast || !live) {
          loggerRef?.warn?.('[mira_qqbot] 恢复会话失败 ' + persistedId + '（' + chatId + '）' + (live ? '，live 且取不到实例，重试耗尽' : '') + '，将新建会话：' + detail)
          break
        }
        loggerRef?.warn?.('[mira_qqbot] 恢复会话失败（live，等待退休后重试）' + persistedId + '（' + chatId + '）：' + msg)
      }
    }
  }

  // ── 新建独立 dsh 会话（延用宿主 agent 机制与默认预设） ──
  if (!agent) {
    await withMetaLock(async () => {
      // 等待锁期间可能已被并发的同一 chatId 处理完成（双检，避免重复新建）
      const again = agentSessions.get(chatId)
      if (again && again.agent) {
        agent = again.agent
        sessionId = again.sessionId
        return
      }
      const newId = 'qq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const h = await svc.create({
        sessionId: newId,
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
        meta: {
          // 关键：指定工作目录，会话归属工作空间（GUI 刷新不丢）；header 记录 preset
          ...(ar.agentCwd ? { cwd: ar.agentCwd } : {}),
          agentPreset: presetId,
        },
        setup: presetSetup,
      })
      agent = h.agent
      ensureSessionTitle(agent, title)
      ensureAgentPresetRecord(agent)
      await attachToWorkspace(newId, ar.agentCwd)
      // 锁内重新读最新映射再写，避免覆盖并发新建的其他会话的绑定
      const freshMeta = loadAgentMeta()
      freshMeta[chatId] = newId
      saveAgentMeta(freshMeta)
      sessionId = newId
      loggerRef?.info?.('[mira_qqbot] 已创建 agent 会话 ' + newId + '（' + chatId + '）' + (ar.agentCwd ? '，工作目录 ' + ar.agentCwd : '，未指定 cwd（会话可能不在界面显示）'))
    })
  }

  agentSessions.set(chatId, { agent, sessionId: sessionId || '' })
  return agent
}

// 提取消息文本：只取 text blocks，跳过 reasoning（模型思考过程）
function messageText(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && (b.type === undefined || b.type === 'text') && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  return ''
}

async function agentReply(agent, text) {
  const session = agent.session
  const before = session.deriveMessages().length
  // 注入完整用户消息：必须带 source（否则宿主 RuntimeContextProjection 读 source.kind 崩溃）
  agent.followup({
    id: 'qqmsg-' + crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const deadline = Date.now() + (cfg.autoReply.agentTimeoutMs || 180000)
  while (agent.status === 'running' && Date.now() < deadline) {
    await sleep(250)
  }
  if (agent.status === 'running') {
    agent.cancel('mira_qqbot 回复超时')
    throw new Error('agent 回复超时（' + (cfg.autoReply.agentTimeoutMs || 180000) + 'ms）')
  }
  // 取本轮新增的 assistant 消息（最后一条为回复）
  const msgs = session.deriveMessages().slice(before)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m && m.role === 'assistant' && messageText(m).trim()) {
      return messageText(m).trim()
    }
  }
  // 可能 followup 后 agent 没有产出（例如用户消息后直接完成）
  const last = msgs[msgs.length - 1]
  const lastText = messageText(last)
  if (lastText) return lastText.trim()
  throw new Error('agent 未产出回复')
}

async function handleAgentReply(chatId, data, text) {
  const agent = await ensureAgent(chatId, sessionTitleFor(data))
  // 不再自动转发：agent 会按提示词调用 qq_send_private_msg / qq_send_group_msg 自己回复
  const reply = await agentReply(agent, text)
  loggerRef?.info?.('[mira_qqbot] agent 已处理 ' + chatId + (reply ? '：' + reply.slice(0, 40) : ''))
}

async function sendReply(data, text) {
  if (data.message_type === 'group') {
    await call('send_group_msg', { group_id: data.group_id, message: text })
  } else {
    await call('send_private_msg', { user_id: data.user_id, message: text })
  }
}

// ── 附件（图片/文件/语音/视频）下载保存 ─────────────────────────
// 保存目录：agentCwd/data 下的 files/；没有 agentCwd 则 /tmp/mira_qqbot_files
function mediaDir() {
  return resolve(dataDir() || '/tmp', 'files')
}

async function downloadTo(url, destPath) {
  const cleanUrl = String(url).replace(/&amp;/g, '&')
  const resp = await fetch(cleanUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Referer: 'https://www.qq.com/',
    },
  })
  if (!resp.ok) throw new Error('HTTP ' + resp.status)
  const buf = Buffer.from(await resp.arrayBuffer())
  mkdirSync(resolve(destPath, '..'), { recursive: true })
  writeFileSync(destPath, buf)
}

// 私聊文件 / 图片本地缓存可能缺失：统一走 OneBot 接口拉取（更长超时）
async function saveViaOneBotApi(action, params, name, dir, errMsg) {
  const r = await call(action, params, 15000)
  mkdirSync(dir, { recursive: true })
  const dest = resolve(dir, name)
  if (r && typeof r.file === 'string') {
    copyFileSync(r.file, dest) // NapCat 返回本地路径：复制到保存目录
    return dest
  }
  if (r && typeof r.base64 === 'string') {
    writeFileSync(dest, Buffer.from(r.base64, 'base64'))
    return dest
  }
  if (r && typeof r.url === 'string') {
    await downloadTo(r.url, dest)
    return dest
  }
  throw new Error(errMsg)
}

// 私聊文件（CQ:file 只有 file_id 没有 url）：走 OneBot get_file 接口
function saveViaGetFile(seg, dir) {
  const name = seg.data.file || ('file_' + Date.now().toString(36) + '.bin')
  return saveViaOneBotApi('get_file', { file_id: seg.data.file_id }, name, dir, 'get_file 无可用结果')
}

// 图片（QQ 直链对外部进程常过期/拒绝）：走 OneBot get_image 接口
function saveViaGetImage(seg, dir) {
  const name = seg.data.file || ('img_' + Date.now().toString(36) + '.jpg')
  return saveViaOneBotApi('get_image', { file: seg.data.file }, name, dir, 'get_image 无可用结果')
}

// 递归收集消息里所有媒体段（含嵌套转发内嵌的），返回扁平 segments 数组
async function collectMediaSegments(data) {
  const segs = Array.isArray(data.message) ? data.message : []
  const media = []
  const seen = new Set()
  async function walk(segments, depth) {
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue
      if (seg.type === 'image' || seg.type === 'file' || seg.type === 'record' || seg.type === 'video') {
        const key = seg.type + '|' + ((seg.data && (seg.data.file || seg.data.file_id || seg.data.url)) || '')
        if (!seen.has(key)) {
          seen.add(key)
          media.push(seg)
        }
      } else if (seg.type === 'forward' && seg.data) {
        if (depth >= 3) continue
        const msgs = await fetchForwardMessages(seg)
        for (const m of msgs) {
          if (Array.isArray(m.message)) await walk(m.message, depth + 1)
        }
      }
    }
  }
  await walk(segs, 0)
  return media
}

// 下载保存一组媒体段，返回 { saved: [{kind, path}], failed: [描述] }
async function saveMediaSegments(segs) {
  const saved = []
  const failed = []
  const dir = mediaDir()
  const kindMap = { image: '图片', file: '文件', record: '语音', video: '视频' }

  async function saveOne(seg) {
    const type = seg.type
    const kind = kindMap[type]
    const url = seg.data && seg.data.url
    const file = seg.data && seg.data.file
    const fileId = seg.data && seg.data.file_id
    let dest = null
    try {
      if (type === 'image' && file) {
        // 图片优先走 OneBot get_image（QQ 直链对外部进程常过期）
        try {
          dest = await saveViaGetImage(seg, dir)
        } catch {
          if (url) {
            const name = type + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) + '.jpg'
            dest = resolve(dir, name)
            await downloadTo(url, dest)
          } else {
            throw new Error('get_image 失败且无 url')
          }
        }
      } else if (type === 'file' && fileId) {
        dest = await saveViaGetFile(seg, dir)
      } else if (url) {
        const extMatch = String(url).match(/\.([A-Za-z0-9]{1,6})(?:\?|$)/)
        const ext = (extMatch && extMatch[1]) || (type === 'image' ? 'jpg' : 'bin')
        const name = type + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext
        dest = resolve(dir, name)
        await downloadTo(url, dest)
      } else {
        return { fail: kind + (file ? '「' + file + '」' : '') + '（无下载链接）' }
      }
      loggerRef?.info?.('[mira_qqbot] 已保存' + kind + '：' + dest)
      return { ok: { kind, path: dest } }
    } catch (e) {
      return { fail: kind + (file ? '「' + file + '」' : '') + '（已失效或下载失败）' }
    }
  }

  const results = await Promise.all(segs.map(saveOne)) // 并发保存，避免历史附件串行拖慢
  for (const r of results) {
    if (r && r.ok) saved.push(r.ok)
    else if (r && r.fail) failed.push(r.fail)
  }
  return { saved, failed }
}

// 把已保存附件的本地路径追加进消息文本，供 agent 后续用工具处理
async function enrichWithMedia(text, data) {
  let out = text
  try {
    const mediaSegs = await collectMediaSegments(data) // 含嵌套转发里的媒体
    const { saved, failed } = await saveMediaSegments(mediaSegs)
    if (saved.length) {
      out += '\n\n【对方发来的附件已保存到本地，路径如下：】\n' +
        saved.map((s) => '- ' + s.kind + '：' + s.path).join('\n')
    }
    if (failed.length) {
      out += '\n【部分附件未能保存：' + failed.join('；') + '】'
    }
  } catch (e) {
    loggerRef?.warn?.('[mira_qqbot] 保存附件失败：' + (e && e.message ? e.message : String(e)))
  }
  return out
}

// 处理一条（可能已合并的）消息：agent 机制或 LLM 直连
async function processMerged(chatId, data, text) {
  const ar = cfg.autoReply
  const rules = promptLines(ar.rulesPrompt, DEFAULT_RULES_PROMPT)
  const isGroup = data.message_type === 'group'
  const nick = (data.sender && (data.sender.card || data.sender.nickname)) || String(data.user_id || '')
  const nature = isGroup ? '群聊' : '私聊'
  const id = isGroup ? data.group_id : data.user_id
  const replyTool = isGroup ? 'qq_send_group_msg' : 'qq_send_private_msg'

  // 【安全规则】（可配置）
  const securityBlock = '【安全规则】\n' + promptLines(ar.securityPrompt, DEFAULT_SECURITY_PROMPT)
  // 【识别名单】
  const trustedList = (ar.trustedUsers || []).filter(Boolean)
  const rosterBlock =
    '【识别名单】\n' +
    (trustedList.length ? trustedList.join('\n') : '（暂无）')
  // 【消息来源】
  const sourceBlock =
    '【消息来源】\n' +
    '工具：mira_qqbot\n' +
    '性质：' + nature + '\n' +
    '用户：' + nick + '\n' +
    'ID号：' + id + '\n' +
    '回复工具：' + replyTool
  // 【当前时间】
  const timeBlock = '【当前时间】\n' + new Date().toLocaleString('zh-CN', { hour12: false })
  // 【行为规则】
  const rulesBlock = '【行为规则】\n' + rules
  // 【聊天消息】
  const msgBlock = '【聊天消息】\n' + text

  const ruledText = securityBlock + '\n\n' + rosterBlock + '\n\n' + sourceBlock + '\n\n' + timeBlock + '\n\n' + rulesBlock + '\n\n' + msgBlock

  // 同一聊天对象严格串行（队列），避免并发 followup 导致回复串味/重复
  if (!agentQueue.has(chatId)) agentQueue.set(chatId, [])
  agentQueue.get(chatId).push({ data, text: ruledText })
  if (sessionBusy.has(chatId)) return // 已有处理循环在跑，本条排队即可
  const run = (async () => {
    try {
      while (true) {
        const q = agentQueue.get(chatId)
        if (!q || q.length === 0) break
        const item = q.shift()
        try {
          await handleAgentReply(chatId, item.data, item.text)
        } catch (e) {
          lastError = 'agent 回复失败：' + (e && e.message ? e.message : String(e))
          loggerRef?.warn?.('[mira_qqbot] agent 回复失败 ' + chatId + '：' + (e && e.message ? e.message : String(e)))
        }
      }
    } finally {
      agentQueue.delete(chatId)
    }
  })()
  sessionBusy.set(chatId, run)
  try {
    await run
  } finally {
    sessionBusy.delete(chatId)
  }
}

async function handleAutoReply(data) {
  const ar = cfg.autoReply
  if (!ar.enabled) return
  const isGroup = data.message_type === 'group'
  if (isGroup && !ar.replyToGroup) return
  if (isGroup && data.group_id === undefined) return
  // 群聊白名单：非空时仅列表中的群应答
  if (isGroup) {
    const wl = (ar.groupWhitelist || []).map(String)
    if (wl.length && !wl.includes(String(data.group_id))) return
  }
  if (data.user_id !== undefined && data.user_id === selfId) return // 不回复自己

  const chatId = isGroup ? 'group:' + data.group_id : 'user:' + data.user_id
  let text = extractText(data)
  // 转发消息：把 [CQ:forward,id=...] 替换为实际内容
  const fwd = await extractForwardContent(data)
  if (fwd) {
    text = text.replace(/\[CQ:forward,[^\]]*\]/g, '[转发消息]\n' + fwd)
  }
  if (!text) return
  // 群聊：消息前标注发送者，合并多条时能区分是谁说的
  if (isGroup) {
    const sn = (data.sender && (data.sender.card || data.sender.nickname)) || String(data.user_id)
    text = '群内昵称（' + sn + '｜' + data.user_id + '）：' + text
  }
  loggerRef?.info?.('[mira_qqbot] 自动应答收到 ' + (isGroup ? '群聊' : '私聊') + '消息 ' + chatId + '：' + text.slice(0, 40))

  // /new 重置会话
  if (ar.newCommand && text.trim() === ar.newCommand) {
    // 释放当前 agent 并删除会话映射，下次消息重建新会话
    const entry = agentSessions.get(chatId)
    if (entry && entry.agent) {
      try { await entry.agent.dispose?.() } catch { /* 忽略 */ }
    }
    agentSessions.delete(chatId)
    await withMetaLock(async () => {
      const meta = loadAgentMeta()
      delete meta[chatId]
      saveAgentMeta(meta)
    })
    loggerRef?.info?.('[mira_qqbot] agent 会话已重置 ' + chatId)
    try {
      await sendReply(data, '新会话已开启~ 重新认识一下吧！(◕ᴗ◕✿)')
    } catch (e) {
      lastError = '自动回复发送失败：' + (e && e.message ? e.message : String(e))
    }
    return
  }

  // 附件保存：把本地路径拼进文本（含嵌套转发里的媒体）
  const fullText = await enrichWithMedia(text, data)

  // 合并窗口：短时间内多条消息合并成一条再处理
  const win = ar.mergeWindowMs || 0
  if (win > 0) {
    let p = pendingMerge.get(chatId)
    if (!p) {
      p = { items: [], timer: null }
      pendingMerge.set(chatId, p)
    }
    p.items.push({ data, text: fullText })
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => flushMerged(chatId), win)
    return
  }

  // 不合并：直接处理
  await processMerged(chatId, data, fullText)
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
function int(description) {
  return { type: 'number', description }
}
function bool(description) {
  return { type: 'boolean', description }
}

function j(v) {
  return JSON.stringify(v, null, 2)
}

function statusView() {
  return {
    connected,
    selfId,
    nickname: selfNickname,
    lastError,
    bufferedMessages: messageBuffer.length,
    lastSeq: messageSeq,
    wsUrl: cfg.wsUrl,
  }
}

function registerTools(ctx) {
  const defs = []

  defs.push(textTool(
    'qq_status',
    '查看 QQ 接管状态：是否连上 NapCat/OneBot、登录的 QQ 号与昵称、已缓冲待读消息数、最近错误等。',
    obj({}),
    async () => j(statusView()),
  ))

  defs.push(textTool(
    'qq_get_login_info',
    '获取当前登录账号（本机 QQ）的基本信息：QQ 号、昵称。',
    obj({}),
    async () => j(await call('get_login_info', {})),
  ))

  defs.push(textTool(
    'qq_get_friend_list',
    '获取好友列表（含备注名、昵称、QQ 号）。',
    obj({}),
    async () => j(await call('get_friend_list', {})),
  ))

  defs.push(textTool(
    'qq_get_group_list',
    '获取已加入的群列表（群号、群名等）。',
    obj({}),
    async () => j(await call('get_group_list', {})),
  ))

  defs.push(textTool(
    'qq_get_group_member_list',
    '获取指定群的成员列表（群号、昵称、名片、身份等）。',
    obj({ group_id: int('群号') }, ['group_id']),
    async (args) => j(await call('get_group_member_list', { group_id: args.group_id })),
  ))

  defs.push(textTool(
    'qq_get_stranger_info',
    '通过 QQ 号查询一个陌生人的公开资料（昵称、性别、年龄等）。',
    obj({ user_id: int('QQ 号'), no_cache: bool('是否绕过缓存（可选）') }, ['user_id']),
    async (args) => j(await call('get_stranger_info', {
      user_id: args.user_id,
      no_cache: args.no_cache === true,
    })),
  ))

  defs.push(textTool(
    'qq_send_private_msg',
    '给指定 QQ 号发送私聊消息。message 支持纯文本，也支持 CQ 码（如 [CQ:image,file=...]）。',
    obj({ user_id: int('对方 QQ 号'), message: str('要发送的消息内容') }, ['user_id', 'message']),
    async (args) => {
      const r = await call('send_private_msg', { user_id: args.user_id, message: String(args.message) })
      return j({ ok: true, message_id: r && r.message_id, user_id: args.user_id })
    },
  ))

  defs.push(textTool(
    'qq_send_group_msg',
    '给指定群发送群消息。message 支持纯文本和 CQ 码；如需 @某人可传 [CQ:at,qq=QQ号]。',
    obj({ group_id: int('群号'), message: str('要发送的消息内容') }, ['group_id', 'message']),
    async (args) => {
      const r = await call('send_group_msg', { group_id: args.group_id, message: String(args.message) })
      return j({ ok: true, message_id: r && r.message_id, group_id: args.group_id })
    },
  ))

  defs.push(textTool(
    'qq_send_msg',
    '统一发消息入口：target 传纯 QQ 号走私聊，传 "group:群号" 走群聊。',
    obj({ target: str('纯 QQ 号（私聊）或 group:群号（群聊）'), message: str('消息内容') }, ['target', 'message']),
    async (args) => {
      const t = String(args.target).trim()
      const msg = String(args.message)
      if (t.startsWith('group:')) {
        const gid = t.slice('group:'.length)
        const r = await call('send_group_msg', { group_id: gid, message: msg })
        return j({ ok: true, channel: 'group', group_id: gid, message_id: r && r.message_id })
      }
      const uid = t
      const r = await call('send_private_msg', { user_id: uid, message: msg })
      return j({ ok: true, channel: 'private', user_id: uid, message_id: r && r.message_id })
    },
  ))

  defs.push(textTool(
    'qq_recv_messages',
    '增量拉取自上次以来收到的 QQ 消息（私聊/群聊/频道）。传 since 为上次返回的最大 seq，首次传 0；返回每条消息的 seq、来源（私聊/群）、发送者、文本内容、message_id 等。可据此应答：私聊用 qq_send_private_msg，群聊用 qq_send_group_msg。',
    obj({ since: int('上次返回的最大 seq，首次 0'), limit: int('最多返回条数，默认 50') }),
    async (args) => {
      const since = Number(args.since || 0)
      const limit = Number(args.limit || 50)
      const list = messageBuffer.filter((m) => m.seq > since).slice(-limit)
      const maxSeq = list.length ? list[list.length - 1].seq : since
      return j({
        since,
        maxSeq,
        count: list.length,
        totalBuffered: messageBuffer.length,
        messages: list,
      })
    },
  ))

  defs.push(textTool(
    'qq_get_msg',
    '按 message_id 查询一条消息的详情。',
    obj({ message_id: int('消息 ID') }, ['message_id']),
    async (args) => j(await call('get_msg', { message_id: args.message_id })),
  ))

  defs.push(textTool(
    'qq_get_group_msg_history',
    '拉取指定群的近期消息历史（NapCat 扩展接口）。',
    obj({ group_id: int('群号'), count: int('条数，默认 20') }, ['group_id']),
    async (args) => j(await call('get_group_msg_history', {
      group_id: args.group_id,
      count: Number(args.count || 20),
    })),
  ))

  defs.push(textTool(
    'qq_delete_msg',
    '撤回一条已发送的消息。',
    obj({ message_id: int('消息 ID') }, ['message_id']),
    async (args) => j(await call('delete_msg', { message_id: args.message_id })),
  ))

  defs.push(textTool(
    'qq_set_group_ban',
    '群禁言：禁言某个群成员指定时长。',
    obj({ group_id: int('群号'), user_id: int('被禁言的 QQ 号'), duration: int('禁言秒数，0 表示解除禁言；默认 1800') }, ['group_id', 'user_id']),
    async (args) => {
      await call('set_group_ban', {
        group_id: args.group_id,
        user_id: args.user_id,
        duration: args.duration === undefined ? 1800 : Number(args.duration),
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_set_group_kick',
    '把某群成员移出群聊。',
    obj({ group_id: int('群号'), user_id: int('被移出的 QQ 号'), reject_add_request: bool('是否拒绝其再次加群（可选）') }, ['group_id', 'user_id']),
    async (args) => {
      await call('set_group_kick', {
        group_id: args.group_id,
        user_id: args.user_id,
        reject_add_request: args.reject_add_request === true,
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_set_group_whole_ban',
    '开启/关闭群全员禁言。',
    obj({ group_id: int('群号'), enable: bool('true 开启全员禁言 / false 关闭') }, ['group_id', 'enable']),
    async (args) => {
      await call('set_group_whole_ban', { group_id: args.group_id, enable: args.enable === true })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_handle_friend_request',
    '处理好友申请：同意或拒绝。flag 来自收到的好友请求事件。',
    obj({ flag: str('申请标识 flag'), approve: bool('true 同意 / false 拒绝'), remark: str('同意后设置的备注（可选）') }, ['flag', 'approve']),
    async (args) => {
      await call('set_friend_add_request', {
        flag: String(args.flag),
        approve: args.approve === true,
        remark: args.remark || '',
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_handle_group_request',
    '处理加群申请：同意或拒绝。flag 与 sub_type 来自收到的加群请求事件。',
    obj({ flag: str('申请标识 flag'), sub_type: str('add / invite'), approve: bool('true 同意 / false 拒绝'), reason: str('拒绝原因（可选）') }, ['flag', 'sub_type', 'approve']),
    async (args) => {
      await call('set_group_add_request', {
        flag: String(args.flag),
        sub_type: String(args.sub_type),
        approve: args.approve === true,
        reason: args.reason || '',
      })
      return j({ ok: true })
    },
  ))

  defs.push(textTool(
    'qq_api',
    '通用 OneBot v11 动作调用（逃生舱）：直接指定 action 与 params 调用 NapCat。仅用于上面工具覆盖不到的接口，如 get_group_info、get_group_honor_info 等。',
    obj({ action: str('OneBot action 名，如 get_group_info'), params: obj({}) }, ['action']),
    async (args) => {
      const r = await call(String(args.action), (args.params && typeof args.params === 'object') ? args.params : {})
      return j(r)
    },
  ))

  const disposers = defs.map((d) => ctx.tools.register(d))
  ctx.effect(() => () => disposers.forEach((d) => d()))
}

// ── 插件入口 ───────────────────────────────────────────────────
export function apply(ctx, config) {
  cfg = deepMerge(structuredClone(DEFAULTS), config || {})
  loggerRef = ctx.logger || null
  // 服务获取一律容错：任何服务缺失/未就绪都不应导致插件加载失败
  try {
    agentsSvc = ctx.agents || null
  } catch {
    agentsSvc = null
  }
  try {
    workspaceSvc = ctx.workspaceRegistry || null
  } catch {
    workspaceSvc = null
  }

  if (cfg.enabled === false) return

  registerTools(ctx)

  ctx.effect(() => {
    connect()
    return () => {
      clearTimers()
      if (ws) {
        try { ws.close() } catch { /* noop */ }
        ws = null
      }
      connected = false
    }
  })

  // 日志里能看出插件加载成功与自动应答状态
  const ar = cfg.autoReply || {}
  if (ar.enabled && !ar.agentCwd) {
    loggerRef?.warn?.('[mira_qqbot] 自动应答已启用但未配置 autoReply.agentCwd：chatId→sessionId 映射将不会持久化，每次重启都会丢失绑定、新建会话。请把 agentCwd 指向你的 DSH 工作空间')
  }
  const mode = ar.enabled
    ? '，自动应答已启用（DSH agent 机制模式' + (agentsSvc ? '' : '，但 agents 服务不可用！') + '）'
    : '，自动应答未启用'
  loggerRef?.info?.('[mira_qqbot] 已加载，OneBot 地址 ' + cfg.wsUrl + mode)
}
