/* mira-live2d 前端看板娘
 * 由主机端通过 tapIndex 注入 index.html，随每个会话的对话界面加载。
 * 支持：拖拽移动、滚轮缩放、右键表情菜单、语音/气泡、指令轮询、状态上报、思考/等待表情联动。
 */
;(function () {
  'use strict'
  if (window.__MIRA_L2D_BOOT__) return
  window.__MIRA_L2D_BOOT__ = true

  const $ = (id) => document.getElementById(id)
  const API = '/live2d/api'

  async function main() {
    let config
    try {
      config = await (await fetch(API + '/config')).json()
    } catch (e) {
      return
    }
    if (!config || config.enabled === false) return

    const W = (config.canvas && config.canvas.w) || 480
    const H = (config.canvas && config.canvas.h) || 630

    /* ── DOM ── */
    const root = document.createElement('div')
    root.id = 'mira-l2d-root'
    root.innerHTML =
      '<canvas id="mira-l2d-canvas"></canvas>' +
      '<div id="mira-l2d-bubble" class="mira-hide"></div>' +
      '<div id="mira-l2d-menu" class="mira-hide"></div>'
    document.body.appendChild(root)

    const canvas = $('mira-l2d-canvas')
    const bubble = $('mira-l2d-bubble')
    const menu = $('mira-l2d-menu')

    /* ── 状态 ── */
    const state = {
      visible: true,
      model: null,
      entry: null,
      expressionsEnabled: true,
      animationsEnabled: true,
      mood: 'idle',
      currentExpression: null,
      currentMotion: null,
      currentUtterance: '',
      expressions: [],
      motions: [],
    }
    let persona = Object.assign(
      { thinking: { expression: '', bubble: '' }, awaiting: { expression: '', bubble: '' }, idleClearMs: 3200 },
      config.persona || {}
    )

    /* ── 画布与 PIXI ── */
    canvas.width = W
    canvas.height = H
    let app
    let model = null
    let viewScale = 1

    /* ── 位置与缩放持久化 ── */
    const POS_KEY = 'mira_l2d_pos'
    const SCALE_KEY = 'mira_l2d_scale'

    function footprint() {
      return { w: W * viewScale, h: H * viewScale }
    }

    function clampPos(x, y) {
      const f = footprint()
      x = Math.max(0, Math.min(x, window.innerWidth - f.w))
      y = Math.max(0, Math.min(y, window.innerHeight - f.h))
      return [x, y]
    }

    function applyPos(x, y) {
      ;[x, y] = clampPos(x, y)
      root.style.left = x + 'px'
      root.style.top = y + 'px'
    }

    function applyScale(s) {
      viewScale = Math.max(0.25, Math.min(3, s))
      root.style.width = W * viewScale + 'px'
      root.style.height = H * viewScale + 'px'
      canvas.style.transform = 'scale(' + viewScale + ')'
      try {
        localStorage.setItem(SCALE_KEY, JSON.stringify(viewScale))
      } catch (e) {}
    }

    // 初始位置：右下 / 左下
    const savedPos = safeGet(POS_KEY)
    const savedScale = safeGet(SCALE_KEY)
    if (savedScale && typeof savedScale === 'number') viewScale = savedScale
    root.style.width = W * viewScale + 'px'
    root.style.height = H * viewScale + 'px'
    canvas.style.transform = 'scale(' + viewScale + ')'

    const f0 = footprint()
    const margin = 16
    if (savedPos && typeof savedPos.x === 'number') {
      applyPos(savedPos.x, savedPos.y)
    } else if (config.position === 'left') {
      applyPos(margin, window.innerHeight - f0.h - margin)
    } else {
      applyPos(window.innerWidth - f0.w - margin, window.innerHeight - f0.h - margin)
    }

    function safeGet(key) {
      try {
        return JSON.parse(localStorage.getItem(key) || 'null')
      } catch (e) {
        return null
      }
    }

    /* ── 模型加载 ── */
    async function loadModel(entry) {
      return await PIXI.live2d.Live2DModel.from('/live2d/models/' + entry)
    }

    // 代次保护：并发 setModel 时，只有最新一次调用能把模型挂上舞台，先到的加载结果作废销毁
    let modelGen = 0
    async function setModel(entry, name) {
      const gen = ++modelGen
      if (!app) {
        app = new PIXI.Application({ view: canvas, autoStart: true, transparent: true, width: W, height: H, resolution: (window.devicePixelRatio || 1) * 3, autoDensity: true })
      }
      let next
      try {
        next = await loadModel(entry)
      } catch (e) {
        if (gen === modelGen) showBubble('模型加载失败：' + (e && e.message ? e.message : e))
        return
      }
      if (gen !== modelGen) {
        // 已被更新的切换取代：丢弃这次加载结果
        try {
          next.destroy && next.destroy()
        } catch (e) {}
        return
      }
      if (model) {
        try {
          app.stage.removeChild(model)
          model.destroy && model.destroy()
        } catch (e) {}
        model = null
      }
      model = next
      app.stage.addChild(model)
      const s = Math.min(W / model.width, H / model.height) * 0.98
      model.scale.set(s)
      model.anchor.set(0.5, 1)
      model.x = W / 2
      model.y = H
      state.model = name
      state.entry = entry
      refreshLists()
      if (state.animationsEnabled) {
        try {
          model.motion('Idle')
        } catch (e) {}
      }
      pushState()
    }

    function refreshLists() {
      try {
        state.expressions = (model.internalModel.settings.expressions || []).map((x) => x.Name)
      } catch (e) {
        state.expressions = []
      }
      try {
        state.motions = Object.keys(model.internalModel.settings.motions || {})
      } catch (e) {
        state.motions = []
      }
    }

    function currentExpression() {
      try {
        const em = model.internalModel && model.internalModel.motionManager
          ? model.internalModel.motionManager.expressionManager : null
        return em && em.currentExpression ? em.currentExpression.Name : null
      } catch (e) {
        return null
      }
    }

    /* ── 气泡 ── */
    let bubbleTimer = null
    function showBubble(text) {
      if (!text) return
      bubble.textContent = text
      bubble.classList.remove('mira-hide')
      state.currentUtterance = text
      clearTimeout(bubbleTimer)
      const ms = Math.min(12000, Math.max(3000, String(text).length * 90))
      bubbleTimer = setTimeout(hideBubble, ms)
    }
    function hideBubble() {
      bubble.classList.add('mira-hide')
      state.currentUtterance = ''
    }

    /* ── 语音 ── */
    let audio = null
    let audioUnlocked = false
    function unlockAudio() {
      if (audioUnlocked) return
      audioUnlocked = true
      const a = new Audio('data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA')
      a.play().then(() => a.pause()).catch(() => {})
    }
    document.addEventListener('pointerdown', unlockAudio, { once: false })

    async function playAudio(audioId) {
      try {
        const r = await (await fetch(API + '/audio/' + encodeURIComponent(audioId))).json()
        if (!r || !r.base64) return
        if (audio) {
          try {
            audio.pause()
          } catch (e) {}
        }
        audio = new Audio('data:' + (r.mime || 'audio/mpeg') + ';base64,' + r.base64)
        const p = audio.play()
        if (p) p.catch(() => {})
      } catch (e) {}
    }

    /* ── 表情 / 动作 ── */
    function setExpression(name) {
      if (!model) return
      if (!state.expressionsEnabled) return
      try {
        if (!name) {
          model.expression(null)
          state.currentExpression = null
        } else if (state.expressions.indexOf(name) >= 0) {
          model.expression(name)
          state.currentExpression = name
        }
      } catch (e) {}
      pushState()
    }

    function playMotion(name) {
      if (!model || !state.animationsEnabled) return
      try {
        model.motion(name)
        state.currentMotion = name
      } catch (e) {}
      pushState()
    }

    /* ── 心情（思考 / 等待 / 空闲） ── */
    let idleTimer = null
    function applyMood(mood) {
      state.mood = mood
      if (mood === 'thinking') {
        clearTimeout(idleTimer)
        const p = persona.thinking || {}
        if (p.expression) setExpression(p.expression)
        if (p.bubble) showBubble(p.bubble)
      } else if (mood === 'awaiting') {
        clearTimeout(idleTimer)
        const p = persona.awaiting || {}
        if (p.expression) setExpression(p.expression)
        if (p.bubble) showBubble(p.bubble)
      } else {
        // idle：延迟后恢复默认
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (state.mood !== 'idle') return
          if (state.expressionsEnabled) {
            try {
              model && model.expression(null)
            } catch (e) {}
            state.currentExpression = null
          }
          hideBubble()
        }, persona.idleClearMs || 0)
      }
      pushState()
    }

    /* ── 指令执行 ── */
    async function execCommand(cmd) {
      switch (cmd.action) {
        case 'expression':
          setExpression(cmd.value || '')
          break
        case 'motion':
          playMotion(cmd.value)
          break
        case 'speak':
          if (cmd.value && cmd.value.text) showBubble(cmd.value.text)
          if (cmd.value && cmd.value.audioId) await playAudio(cmd.value.audioId)
          break
        case 'bubble':
          showBubble(cmd.value || '')
          break
        case 'show':
          state.visible = true
          root.classList.remove('mira-hidden')
          pushState()
          break
        case 'hide':
          state.visible = false
          root.classList.add('mira-hidden')
          pushState()
          break
        case 'switch_model':
          if (cmd.value && cmd.value.entry) await setModel(cmd.value.entry, cmd.value.model)
          break
        case 'set_expressions':
          state.expressionsEnabled = !!cmd.value
          if (!state.expressionsEnabled && model) {
            try {
              model.expression(null)
            } catch (e) {}
          }
          pushState()
          break
        case 'set_animations':
          state.animationsEnabled = !!cmd.value
          pushState()
          break
        case 'set_persona':
          persona = Object.assign(
            { thinking: { expression: '', bubble: '' }, awaiting: { expression: '', bubble: '' }, idleClearMs: 3200 },
            cmd.value || {}
          )
          break
        case 'mood':
          applyMood(cmd.value || 'idle')
          break
      }
    }

    /* ── 指令轮询 ── */
    // 消费位置持久化：刷新后从上次位置继续，不重放历史指令（避免重新触发模型切换等副作用）
    const CMD_ID_KEY = 'mira_l2d_cmd_id'
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
            try {
              localStorage.setItem(CMD_ID_KEY, JSON.stringify(lastCommandId))
            } catch (e) {}
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
    setInterval(pollCommands, config.pollIntervalMs || 1500)
    pollCommands()

    /* ── 状态上报 ── */
    let pushingState = false
    function pushState() {
      if (pushingState) return
      pushingState = true
      const payload = {
        visible: state.visible,
        model: state.model,
        currentExpression: currentExpression() || state.currentExpression,
        currentMotion: state.currentMotion,
        currentUtterance: state.currentUtterance,
        expressions: state.expressions,
        motions: state.motions,
        expressionsEnabled: state.expressionsEnabled,
        animationsEnabled: state.animationsEnabled,
        mood: state.mood,
        t: Date.now(),
      }
      fetch(API + '/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .catch(() => {})
        .finally(() => {
          pushingState = false
        })
    }
    setInterval(pushState, 5000)

    /* ── 拖拽移动 ── */
    let dragging = false
    let dragDx = 0
    let dragDy = 0
    root.addEventListener('pointerdown', (e) => {
      if (e.target === menu || menu.contains(e.target)) return
      if (e.button !== 0) return
      dragging = true
      root.setPointerCapture(e.pointerId)
      const r = root.getBoundingClientRect()
      dragDx = e.clientX - r.left
      dragDy = e.clientY - r.top
      e.preventDefault()
    })
    root.addEventListener('pointermove', (e) => {
      if (!dragging) return
      applyPos(e.clientX - dragDx, e.clientY - dragDy)
    })
    function endDrag() {
      if (!dragging) return
      dragging = false
      const r = root.getBoundingClientRect()
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }))
      } catch (e) {}
    }
    root.addEventListener('pointerup', endDrag)
    root.addEventListener('pointercancel', endDrag)

    /* ── 滚轮缩放 ── */
    root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const factor = e.deltaY < 0 ? 1.08 : 0.92
        const r = root.getBoundingClientRect()
        const cx = e.clientX - r.left
        const cy = e.clientY - r.top
        const newScale = viewScale * factor
        applyScale(newScale)
        // 以鼠标位置为锚点调整位置
        const nx = e.clientX - cx * (newScale / viewScale)
        const ny = e.clientY - cy * (newScale / viewScale)
        applyPos(nx, ny)
        applyScale(newScale)
      },
      { passive: false }
    )

    /* ── 右键表情菜单 ── */
    function buildMenu(x, y) {
      menu.innerHTML = ''
      const items = []
      items.push({ label: '默认表情', value: '' })
      for (const exp of state.expressions) items.push({ label: exp, value: exp })
      items.push({ type: 'sep' })
      for (const m of state.motions) items.push({ label: '动作 · ' + m, value: '__motion__' + m })
      items.push({ type: 'sep' })
      items.push({ label: state.visible ? '隐藏看板娘' : '显示看板娘', value: '__toggle_visible__' })

      for (const it of items) {
        if (it.type === 'sep') {
          const s = document.createElement('div')
          s.className = 'mira-menu-sep'
          menu.appendChild(s)
          continue
        }
        const b = document.createElement('div')
        b.className = 'mira-menu-item'
        b.textContent = it.label
        b.addEventListener('click', () => {
          hideMenu()
          if (it.value === '__toggle_visible__') {
            execCommand({ action: state.visible ? 'hide' : 'show' })
          } else if (typeof it.value === 'string' && it.value.indexOf('__motion__') === 0) {
            playMotion(it.value.slice('__motion__'.length))
          } else {
            setExpression(it.value)
          }
        })
        menu.appendChild(b)
      }
      menu.classList.remove('mira-hide')
      menu.style.left = Math.min(x, window.innerWidth - 200) + 'px'
      menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px'
    }
    function hideMenu() {
      menu.classList.add('mira-hide')
    }
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      buildMenu(e.clientX, e.clientY)
    })
    document.addEventListener('click', (e) => {
      if (menu.contains(e.target)) return
      hideMenu()
    })
    document.addEventListener('scroll', hideMenu, true)

    /* ── 视线跟随 ── */
    document.addEventListener('pointermove', (e) => {
      if (!model) return
      const r = canvas.getBoundingClientRect()
      try {
        model.focus((e.clientX - r.left) / viewScale, (e.clientY - r.top) / viewScale)
      } catch (err) {}
    })

    /* ── 初始模型 / 提示 ── */
    if (config.modelEntry) {
      await setModel(config.modelEntry, config.model)
      if (config.showHint !== false) {
        showBubble('右键切换表情 · 滚轮缩放 · 拖拽移动')
      }
    } else if (config.showHint !== false) {
      showBubble('未配置模型：请在插件 model 文件夹放入模型')
    }

    // 暴露给调试/手动控制
    window.MiraL2D = {
      setExpression,
      playMotion,
      showBubble,
      setMood: applyMood,
      show: () => execCommand({ action: 'show' }),
      hide: () => execCommand({ action: 'hide' }),
    }
  }

  main()
})()
