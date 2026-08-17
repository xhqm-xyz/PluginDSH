/* tavern 酒馆前端面板
 * 由主机端通过 tapIndex 注入 index.html，随每个会话的对话界面加载。
 * 支持：剧本选择、逐幕演绎、拖拽移动、收起/隐藏、台词朗读（TTS）、
 * 指令轮询（模型导演模式）、状态上报。
 */
;(function () {
  'use strict'
  if (window.__TAVERN_BOOT__) return
  window.__TAVERN_BOOT__ = true

  const API = '/tavern/api'
  const POS_KEY = 'tavern_pos'
  const CMD_ID_KEY = 'tavern_cmd_id'
  const SCRIPT_KEY = 'tavern_last_script'
  const SCENE_KEY = 'tavern_last_scene'

  function safeGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') } catch (e) { return null }
  }
  function safeSet(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)) } catch (e) {}
  }

  async function main() {
    let config
    try {
      config = await (await fetch(API + '/config')).json()
    } catch (e) {
      return
    }
    if (!config || config.enabled === false) return

    const W = (config.panel && config.panel.w) || 380
    const H = (config.panel && config.panel.h) || 560

    /* ── DOM ── */
    const root = document.createElement('div')
    root.id = 'tavern-root'
    root.innerHTML =
      '<div id="tavern-panel">' +
        '<div id="tavern-header">' +
          '<span id="tavern-title"></span>' +
          '<span id="tavern-script-name"></span>' +
          '<span class="tavern-hbtns">' +
            '<button id="tavern-min-btn" title="收起/展开">—</button>' +
            '<button id="tavern-close-btn" title="关闭">×</button>' +
          '</span>' +
        '</div>' +
        '<div id="tavern-body"></div>' +
        '<div id="tavern-footer">' +
          '<button id="tavern-prev" title="上一幕">⏮</button>' +
          '<button id="tavern-read" title="朗读本幕">🔊 朗读</button>' +
          '<button id="tavern-next" title="下一幕">⏭</button>' +
          '<select id="tavern-scenes" title="跳转到幕"></select>' +
        '</div>' +
        '<div id="tavern-toast"></div>' +
      '</div>' +
      '<div id="tavern-tab">🍺 酒馆</div>'
    document.body.appendChild(root)

    const $ = (id) => document.getElementById(id)
    const panel = $('tavern-panel')
    const body = $('tavern-body')
    const titleEl = $('tavern-title')
    const scriptNameEl = $('tavern-script-name')
    const scenesSel = $('tavern-scenes')
    const toast = $('tavern-toast')
    const tab = $('tavern-tab')

    titleEl.textContent = config.title || '酒馆'
    panel.style.width = W + 'px'
    panel.style.height = H + 'px'

    /* ── 状态 ── */
    const state = {
      visible: true,
      minimized: false,
      script: null,
      sceneIndex: 0,
      ttsEnabled: !!(config.tts && config.tts.enabled),
      ttsReady: !!(config.tts && config.tts.ready),
    }

    function currentScene() {
      return state.script ? state.script.scenes[state.sceneIndex] : null
    }

    /* ── 位置持久化 ── */
    function applyPos(x, y) {
      const r = panel.getBoundingClientRect()
      const w = r.width || W
      const h = r.height || H
      x = Math.max(0, Math.min(x, window.innerWidth - w))
      y = Math.max(0, Math.min(y, window.innerHeight - h))
      root.style.left = x + 'px'
      root.style.top = y + 'px'
    }
    const margin = 16
    const savedPos = safeGet(POS_KEY)
    if (savedPos && typeof savedPos.x === 'number') applyPos(savedPos.x, savedPos.y)
    else if (config.position === 'left') applyPos(margin, margin)
    else applyPos(window.innerWidth - W - margin, margin)

    /* ── 拖拽（仅标题栏） ── */
    let dragging = false
    let dd = { dx: 0, dy: 0 }
    const header = $('tavern-header')
    header.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.tagName === 'BUTTON') return
      dragging = true
      header.setPointerCapture(e.pointerId)
      const r = panel.getBoundingClientRect()
      dd.dx = e.clientX - r.left
      dd.dy = e.clientY - r.top
      e.preventDefault()
    })
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return
      applyPos(e.clientX - dd.dx, e.clientY - dd.dy)
    })
    function endDrag() {
      if (!dragging) return
      dragging = false
      const r = panel.getBoundingClientRect()
      safeSet(POS_KEY, { x: r.left, y: r.top })
    }
    header.addEventListener('pointerup', endDrag)
    header.addEventListener('pointercancel', endDrag)

    /* ── 显隐 / 收起 ── */
    function setVisible(v) {
      state.visible = v
      root.classList.toggle('tavern-hidden', !v)
      pushState()
    }
    function setMinimized(m) {
      state.minimized = m
      root.classList.toggle('tavern-min', m)
      pushState()
    }
    $('tavern-close-btn').addEventListener('click', () => setVisible(false))
    $('tavern-min-btn').addEventListener('click', () => setMinimized(!state.minimized))
    tab.addEventListener('click', () => setVisible(true))

    /* ── 音频 ── */
    let audio = null
    function stopAudio() {
      if (audio) {
        try { audio.pause() } catch (e) {}
        audio = null
      }
    }
    function playData(r) {
      return new Promise((resolve) => {
        if (!r || !r.base64) return resolve()
        stopAudio()
        audio = new Audio('data:' + (r.mime || 'audio/mpeg') + ';base64,' + r.base64)
        let done = false
        const fin = () => { if (!done) { done = true; resolve() } }
        audio.addEventListener('ended', fin)
        audio.addEventListener('error', fin)
        const p = audio.play()
        if (p) p.catch(fin)
        setTimeout(fin, 60000) // 硬上限，避免朗读卡住
      })
    }
    async function fetchAudio(audioId) {
      try {
        return await (await fetch(API + '/audio/' + encodeURIComponent(audioId))).json()
      } catch (e) {
        return null
      }
    }
    async function speakText(text, voice) {
      if (!text || !state.ttsEnabled || !state.ttsReady) return
      try {
        const r = await (await fetch(API + '/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: String(text).slice(0, 600), voice: voice || '' }),
        })).json()
        if (r && r.base64) await playData(r)
      } catch (e) {}
    }

    function voiceFor(speakerId) {
      const s = state.script
      if (!s) return ''
      if (speakerId === 'narrator') return (s.narrator && s.narrator.voice) || ''
      const ch = (s.characters || []).find((c) => c.id === speakerId)
      return ch ? ch.voice || '' : ''
    }
    function speakerName(speakerId) {
      const s = state.script
      if (!s) return speakerId
      if (speakerId === 'narrator') return (s.narrator && s.narrator.name) || '旁白'
      const ch = (s.characters || []).find((c) => c.id === speakerId)
      return ch ? ch.name : speakerId
    }
    function speakerColor(speakerId) {
      const s = state.script
      if (!s) return '#9aa0b0'
      if (speakerId === 'narrator') return '#8a8f9e'
      const ch = (s.characters || []).find((c) => c.id === speakerId)
      return ch && ch.color ? ch.color : '#9aa0b0'
    }

    /* ── 渲染 ── */
    function el(tag, cls, text) {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      if (text != null) e.textContent = text
      return e
    }

    async function renderBody() {
      body.innerHTML = ''
      if (!state.script) {
        let list
        try {
          list = await (await fetch(API + '/scripts')).json()
        } catch (e) {
          list = { scripts: [] }
        }
        const scripts = (list && list.scripts) || []
        body.appendChild(el('div', 'tavern-pick-title', '选择剧本'))
        if (!scripts.length) {
          body.appendChild(el('div', 'tavern-empty', 'scripts 目录没有剧本（*.script.json）'))
          return
        }
        for (const s of scripts) {
          const item = el('div', 'tavern-script-item')
          item.appendChild(el('div', 'tavern-script-title', s.title))
          item.appendChild(el('div', 'tavern-script-desc', (s.description || '') + (s.sceneCount ? ' · ' + s.sceneCount + ' 幕' : '')))
          item.addEventListener('click', () => loadScript(s.id))
          body.appendChild(item)
        }
        return
      }

      const scene = currentScene()
      if (!scene) {
        body.appendChild(el('div', 'tavern-empty', '剧本为空'))
        return
      }
      const head = el('div', 'tavern-scene-head')
      head.appendChild(el('span', 'tavern-scene-pos', '第 ' + (state.sceneIndex + 1) + ' / ' + state.script.scenes.length + ' 幕'))
      head.appendChild(el('b', 'tavern-scene-title', scene.title || scene.id))
      body.appendChild(head)

      if (scene.stage) body.appendChild(el('div', 'tavern-stage', scene.stage))

      if (scene.narration) {
        const n = el('div', 'tavern-narration')
        n.appendChild(el('span', 'tavern-narrator-label', speakerName('narrator')))
        n.appendChild(el('span', 'tavern-narration-text', scene.narration))
        const spk = el('button', 'tavern-line-speak', '🔊')
        spk.addEventListener('click', () => speakText(scene.narration, voiceFor('narrator')))
        n.appendChild(spk)
        body.appendChild(n)
      }

      const lines = el('div', 'tavern-lines')
      for (const line of scene.lines) {
        const li = el('div', 'tavern-line')
        const top = el('div', 'tavern-line-top')
        const spkName = el('span', 'tavern-speaker', speakerName(line.speaker))
        spkName.style.color = speakerColor(line.speaker)
        top.appendChild(spkName)
        if (line.action) top.appendChild(el('span', 'tavern-action', '（' + line.action + '）'))
        const spk = el('button', 'tavern-line-speak', '🔊')
        spk.addEventListener('click', () => speakText(line.text, voiceFor(line.speaker)))
        top.appendChild(spk)
        li.appendChild(top)
        li.appendChild(el('div', 'tavern-text', line.text))
        lines.appendChild(li)
      }
      body.appendChild(lines)
      refreshScenes()
    }

    function refreshScenes() {
      scenesSel.innerHTML = ''
      if (!state.script) return
      state.script.scenes.forEach((s, i) => {
        const o = document.createElement('option')
        o.value = String(i)
        o.textContent = (i + 1) + '. ' + (s.title || s.id)
        scenesSel.appendChild(o)
      })
      scenesSel.value = String(state.sceneIndex)
    }

    function gotoScene(i) {
      const s = state.script
      if (!s) return
      if (i < 0 || i >= s.scenes.length) return
      state.sceneIndex = i
      renderBody()
      persistScene()
      pushState()
    }

    async function loadScript(id) {
      try {
        const r = await (await fetch(API + '/script?id=' + encodeURIComponent(id))).json()
        if (!r || !r.script) return
        state.script = r.script
        state.sceneIndex = 0
        scriptNameEl.textContent = state.script.title
        safeSet(SCRIPT_KEY, id)
        await renderBody()
        pushState()
      } catch (e) {}
    }

    function persistScene() {
      if (state.script) safeSet(SCENE_KEY, { id: state.script.id, index: state.sceneIndex })
    }

    /* ── 朗读本幕 ── */
    async function readScene() {
      const scene = currentScene()
      if (!scene) return
      stopAudio()
      if (scene.narration) await speakText(scene.narration, voiceFor('narrator'))
      for (const line of scene.lines) {
        if (!line.text) continue
        await speakText(line.text, voiceFor(line.speaker))
      }
    }

    $('tavern-prev').addEventListener('click', () => gotoScene(state.sceneIndex - 1))
    $('tavern-next').addEventListener('click', () => gotoScene(state.sceneIndex + 1))
    $('tavern-read').addEventListener('click', readScene)
    scenesSel.addEventListener('change', () => gotoScene(Number(scenesSel.value)))

    /* ── 提示气泡 ── */
    let toastTimer = null
    function showToast(text) {
      if (!text) return
      toast.textContent = text
      toast.classList.add('tavern-show')
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toast.classList.remove('tavern-show'), 6000)
    }

    /* ── 指令执行 ── */
    async function execCommand(cmd) {
      switch (cmd.action) {
        case 'show':
          setVisible(true)
          break
        case 'hide':
          setVisible(false)
          break
        case 'load':
          if (cmd.value && cmd.value.scriptId) await loadScript(cmd.value.scriptId)
          break
        case 'scene': {
          const v = cmd.value || {}
          if (v.scriptId && (!state.script || state.script.id !== v.scriptId)) await loadScript(v.scriptId)
          if (typeof v.sceneIndex === 'number') gotoScene(v.sceneIndex)
          break
        }
        case 'speak': {
          const v = cmd.value || {}
          if (v.text) showToast(v.speaker ? speakerName(v.speaker) + '：' + v.text : v.text)
          if (v.audioId) {
            const r = await fetchAudio(v.audioId)
            if (r) await playData(r)
          }
          break
        }
        case 'next':
          gotoScene(state.sceneIndex + 1)
          break
        case 'prev':
          gotoScene(state.sceneIndex - 1)
          break
      }
    }

    /* ── 指令轮询 ── */
    let lastCommandId = (() => {
      try {
        const v = JSON.parse(localStorage.getItem(CMD_ID_KEY) || '0')
        return typeof v === 'number' && v > 0 ? v : 0
      } catch (e) {
        return 0
      }
    })()
    let polling = false
    async function pollCommands() {
      if (polling) return
      polling = true
      try {
        const r = await (await fetch(API + '/commands?since=' + lastCommandId)).json()
        const list = (r && r.commands) || []
        for (const cmd of list) {
          if (cmd && cmd.id > lastCommandId) {
            lastCommandId = cmd.id
            safeSet(CMD_ID_KEY, lastCommandId)
          }
          try {
            await execCommand(cmd)
          } catch (e) {}
        }
      } catch (e) {
      } finally {
        polling = false
      }
    }
    setInterval(pollCommands, config.pollIntervalMs || 1200)
    pollCommands()

    /* ── 状态上报 ── */
    function pushState() {
      const scene = currentScene()
      const payload = {
        visible: state.visible,
        minimized: state.minimized,
        scriptId: state.script ? state.script.id : null,
        sceneIndex: state.sceneIndex,
        sceneTitle: scene ? scene.title : null,
        t: Date.now(),
      }
      fetch(API + '/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    }
    setInterval(pushState, 5000)

    /* ── 恢复上次剧本 ── */
    const lastScriptId = safeGet(SCRIPT_KEY)
    const lastScene = safeGet(SCENE_KEY)
    if (lastScriptId) {
      try {
        const r = await (await fetch(API + '/script?id=' + encodeURIComponent(lastScriptId))).json()
        if (r && r.script) {
          state.script = r.script
          scriptNameEl.textContent = r.script.title
          state.sceneIndex = lastScene && typeof lastScene.index === 'number' && lastScene.index >= 0 && lastScene.index < r.script.scenes.length
            ? lastScene.index
            : 0
          await renderBody()
        }
      } catch (e) {}
    } else {
      await renderBody()
    }

    pushState()

    window.Tavern = {
      loadScript,
      gotoScene,
      readScene,
      show: () => setVisible(true),
      hide: () => setVisible(false),
    }
  }

  main()
})()
