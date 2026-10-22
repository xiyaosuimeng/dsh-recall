/**
 * dsh-recall —— **每轮自动把相关的旧记忆递到模型眼前**（第 4 步）
 *
 * ## 它治什么
 *
 * 前三步（场景表 / 状态快照 / 语义检索）解决的是"**记忆能被找到**"，但都是
 * **开局检索一次**。聊到第两小时话题飘了，后面的记忆不会自己来 —— 除非模型想起来去搜。
 * 这个插件把它变成"**每说一句话，相关的旧记忆自己送到**"。
 *
 * ## 三条设计红线（每一条都是踩出来的）
 *
 * 1. **只往消息列表末尾追加，绝不动系统提示，也**不改他那条消息**。**
 *    前缀缓存（实测 99.36% 命中）的规则是"从头一模一样才算命中" ——
 *    动开头 = 整条缓存作废 = 费用可能涨十倍。
 *    所以注入**只能加在尾巴**：历史和他的原话前面一个字节不动。
 *
 *    ★ 2026-10-22 改：以前是"追加到他那条 user 消息的 content 末尾" ——
 *    前缀同样没变（对缓存友好），但**他看到的是"我的话里带着一堆资料"**，
 *    原话：「能不能做成随我的指令直接回忆记忆而不是直接种在我的指令里」。
 *    现在改成**追加一条独立的注入消息**，他的原话一个字节都不碰。
 *    这条路 `persona-continuity` 已经跑通（开局块就是它注入的独立 user 消息）。
 *
 * 2. **独立消息必须自带 `id` 和 `source.kind`，两个缺一不可。**
 *    - 2026-10-16 `dsh-keyword-gate` 走"造消息"被 DSH 拒：
 *      `format v4 message requires a producer-owned source kind`
 *      → 正解是挂一个**非空**的 `source.kind`（这里用插件自己的名字）。
 *    - 2026-10-13 `persona-continuity` **漏了 `id`**：会话落盘后下次加载校验失败、
 *      **整个会话打不开**。症状和病因隔着一整个重启，极难发现。
 *      → 这里的 `id` 用 `randomUUID()`，**不是可选项**。
 *    - 其余形状要求：`role` 必须是 `'user'`，`content` 必须是数组。
 *
 * 3. **默认 dryRun（只记日志、不碰消息）。**
 *    这是"每轮都跑"的东西，出错的代价最大。dryRun 期间它只在
 *    `_tmp\recall_plugin.log` 里写"我本来会注入什么"，确认判准之后再关掉。
 *
 * ## ★ 2026-10-22 第二条触发线：「动作触发」（他点名要的）
 *
 * 他的原话：「我不需要我说到时你想起来，而是你做这件事的时候自己回想起来」。
 * 原来的检索词**只有他这句话**（`index.js` 里 `query = textOf(msg)`）——
 * 于是他说"检查一下"就检索不到东西，而我正在改 `cred_guard.py`、正在扫会话日志
 * 这些**动作**根本不进检索词。记忆只在"他提到"时才来，正是他说的毛病。
 *
 * 现在加第二条线：**最近一次工具动作 → 检索**。
 * 检索词 = 工具名 + 参数/命令/路径（截断）+ 结果片段，例：
 *   `[edit] tools/cred_guard.py ...`
 *   `[bash] python tools/cred_guard.py --days 30 ...`
 *
 * 三条防噪音阀（不然每步插一段 = 噪音）：
 *   - **动作签名**（工具名+参数哈希）相同 → 不重复检索；
 *   - **最小间隔** `actionMinIntervalMs`（默认 12s）；
 *   - **每轮上限** `actionMaxPerTurn`（默认 3 条）；同一批注入块全局去重。
 *
 * ## 其它安全阀
 *
 * - **同一条消息只注入一次**（按消息 id 记，避免 pre-step 重入时重复塞）
 * - 检索走 `tools\recall_once.py`，**它自己不注入就什么都不返回**（阈值在那边）
 * - 超时（默认 8 秒）/ 任何异常 → **放行**（fail-open，绝不连累对话）
 * - 注入块头部写明"**供参考，不必回应，也不要当成他的原话**"
 */

import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'

export const name = 'dsh-recall'

// ⚠️ **不要**声明 `inject`：这个插件不依赖任何服务。
//    第一版从别的插件抄了 `inject = { optional: ['webServer'] }`，
//    结果条目卡在 `pending (waiting for service: optional)` —— **永远不会启用**
//    （插件页只显示一条 warning，很容易被当成"装好了"）。
//    没有依赖就不声明；要声明也只在**真的用得上**的时候。

/** 注入消息的 `source.kind`：既是 DSH 要的 "producer-owned" 证明，也让我认出自己。 */
const SOURCE_KIND = 'dsh-recall'

const CONTEXT_FORMS = ['context', 'system-prompt', 'goal', 'continuation', 'summary']

function logPath() {
  return process.env.DSH_RECALL_LOG || "recall_plugin.log"
}

async function log(line) {
  try {
    const t = new Date().toTimeString().slice(0, 8)
    await appendFile(logPath(), `${t}  ${line}\n`, 'utf8')
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

function textOf(message) {
  const content = message && message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text + '\n'
  }
  return out
}

/** 是不是"真人在说话"（保守判准，跟参考实现同源）。 */
function isHumanInput(message) {
  if (!message || message.role !== 'user') return false
  const source = message.source
  if (!source || typeof source !== 'object') return false
  if (CONTEXT_FORMS.indexOf(source.form) >= 0) return false
  if (source.kind !== undefined && source.kind !== 'model' && source.kind !== 'user') return false
  return true
}

// ---- 动作触发：从消息窗口里认出「我刚刚干了什么」----------------------------

/** 这条消息是不是工具结果。 */
function isToolResult(message) {
  if (!message) return false
  if (message.role === 'tool') return true
  const kind = message.source && message.source.kind
  return kind === 'tool' || kind === 'tool-result'
}

/**
 * 从一条消息里找工具调用块（不同版本的消息形状不一样，这里都认）。
 * → { name, args, callId } 或 null
 */
function toolCallOf(message) {
  if (!message) return null
  const src = message.source || {}
  // 形状 A：消息本身就是一次调用
  if (src.kind === 'tool-call' || message.role === 'tool-call') {
    return { name: String(message.name || src.name || ''), args: String(message.arguments ?? message.input ?? ''), callId: String(message.callId || src.callId || '') }
  }
  // 形状 B：content 里的 tool-call / tool_use 块
  const content = message.content
  if (!Array.isArray(content)) return null
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const t = String(b.type || '')
    if (t === 'tool-call' || t === 'tool_use' || t === 'tool-use') {
      const args = b.arguments ?? b.input ?? b.args ?? ''
      return {
        name: String(b.name || b.toolName || ''),
        args: typeof args === 'string' ? args : JSON.stringify(args),
        callId: String(b.id || b.callId || b.toolCallId || ''),
      }
    }
  }
  return null
}

/**
 * ★ 动作触发的检索词：取**最近一次**工具动作（调用或结果）+ 结果片段。
 * → { query, sig } 或 null（没有工具动作时）
 *
 * 认不出的形状**宁可返回 null**（不注入），也不要拿一条错误的东西去检索。
 */
function actionQuery(messages) {
  if (!Array.isArray(messages) || !messages.length) return null
  let action = null
  let resultText = ''
  // 从后往前找：最近的工具结果 / 工具调用
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 12; i--) {
    const m = messages[i]
    if (!action) {
      const call = toolCallOf(m)
      if (call && (call.name || call.args)) { action = call; continue }
    }
    if (!resultText && isToolResult(m)) {
      resultText = textOf(m).trim()
      // 结果消息自带 tool 名（有的版本有）
      const src = m.source || {}
      if (!action && (src.name || m.name)) {
        action = { name: String(m.name || src.name), args: '', callId: String(m.toolCallId || src.callId || '') }
      }
    }
    if (action && resultText) break
  }
  if (!action && !resultText) return null
  // 只有结果、没有调用块的情况很常见（某些版本的调用是独立事件，不进 messages）
  // ⇒ 拿结果片段单独当检索词也行，别因为认不出工具名就整条放弃。
  const parts = []
  if (action && action.name) parts.push(`[${action.name}]`)
  let args = ''
  if (action && action.args) args = action.args.replace(/\s+/g, ' ').slice(0, 260)
  if (args) parts.push(args)
  if (resultText) parts.push(resultText.replace(/\s+/g, ' ').slice(0, 200))
  const query = parts.join(' ').trim()
  if (query.length < 8) return null
  const sigBase = action && (action.name || action.args)
    ? action.name + '\u0000' + action.args
    : resultText.slice(0, 160)
  const sig = hashStr(sigBase)
  return { query, sig }
}

function hashStr(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
}

/** 从后面找最近一条"人话"消息的下标（没有则 -1）。 */
function lastHumanIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanInput(messages[i])) return i
  }
  return -1
}

/**
 * 造一条**独立的**注入消息（不改他那条，也不复用他的 id）。
 *
 * ⚠️ `id` 不是可选项：漏了它，会话文件落盘后下次加载会校验失败、**整个会话打不开**
 *    （persona-continuity 2026-10-13 的坑，见该插件 index.js:49-65）。
 * ⚠️ `source.kind` 必须非空：否则 DSH 拒
 *    `format v4 message requires a producer-owned source kind`
 *    （2026-10-16 dsh-keyword-gate 实测）。
 */
function recallMessage(block) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: block }],
    source: { kind: SOURCE_KIND },
  }
}

/** 把注入消息**追加到列表末尾**（他的原话一条都不改；前缀缓存不受影响）。 */
function withRecall(messages, block) {
  return [...messages, recallMessage(block)]
}

function runRecall(python, script, query, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(python, [script, query], { timeout: timeoutMs, windowsHide: true,
        maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) { resolve({ ok: false, err: String(err.message || err) }) }
        else resolve({ ok: true, block: String(stdout || '').trim() })
      })
    } catch (e) {
      resolve({ ok: false, err: String(e && e.message || e) })
    }
  })
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const dryRun = config.dryRun !== false          // ★ 默认就是 dryRun
  const python = config.python ||
    'python'
  const script = config.script || '%DSH_WORKSPACE%\\tools\\recall_once.py'
  const timeoutMs = Number(config.timeoutMs || 8000)
  const minQueryLen = Number(config.minQueryLen || 6)
  // ★ 动作触发（2026-10-22）
  const actionTrigger = config.actionTrigger !== false
  const actionMinIntervalMs = Number(config.actionMinIntervalMs || 12000)
  const actionMaxPerTurn = Number(config.actionMaxPerTurn || 3)
  // 动作触发先只用 dryRun 观察（他的原话路径保持现在的行为），确认不吵再关
  const actionDryRun = config.actionDryRun !== false

  const stats = { checked: 0, injected: 0, skipped: 0, errors: 0, lastVerdict: '（还没跑过）' }
  const done = new Set()                          // 已处理过的消息 id
  const seenBlocks = new Set()                    // 已注入过的块（全局去重）
  let payloadMessages = []                        // 本次 pre-step 的完整消息列表
  let actionCount = 0                             // 本轮动作注入次数
  let lastActionSig = ''                          // 上一个动作签名
  let lastActionAt = 0                            // 上次动作检索时间

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (!enabled) return next()
      const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
      payloadMessages = messages

      // ---- 第一优先级：他刚说话 → 用他的话检索（老路径，行为不变）----
      const humanIdx = lastHumanIndex(messages)
      if (humanIdx >= 0) {
        const msg = messages[humanIdx]
        const key = String(msg.id ?? '')
        if (key && done.has(key)) {
          // 这条已经处理过 → 看看是不是该走动作触发
        } else {
          actionCount = 0                          // 新的一轮：动作配额清零
          const query = textOf(msg).trim()
          if (query.length >= minQueryLen) {
            if (key) done.add(key)
            stats.checked++
            const r = await runRecall(python, script, query, timeoutMs)
            const handled = await finish(r, query, '他说的', next)
            if (handled) return handled
          }
        }
      }

      // ---- 第二优先级：我在干活 → 用**动作**检索（★ 新增）----
      if (!actionTrigger) return next()
      if (mediaInFlight(messages)) return next()
      const a = actionQuery(messages)
      if (!a) return next()
      if (a.sig === lastActionSig) return next()           // 同一个动作不重复查
      if (actionCount >= actionMaxPerTurn) return next()    // 本轮配额用完
      const now = Date.now()
      if (now - lastActionAt < actionMinIntervalMs) return next()
      lastActionSig = a.sig
      lastActionAt = now
      stats.checked++
      const r = await runRecall(python, script, a.query, timeoutMs)
      if (actionDryRun) {
        // ★ 动作触发先只观察：**每次都记一行**（命中 0 条也记）——
        //   否则"没日志"分不清是"没触发"还是"触发了但没命中"（C57：判据太窄看不到真相）。
        await log(`[ACTION-DRY] query=${JSON.stringify(a.query.slice(0, 90))} → ` +
          (r.ok ? (r.block ? `本来会注入 ${r.block.length} 字` : '没有够相关的旧记忆（不注入）')
                : '检索失败（放行）'))
        return next()
      }
      const handled = await finish(r, a.query, '动作', next, false)
      if (handled) {
        actionCount++
        return handled
      }
      return next()
    } catch (e) {
      stats.errors++
      stats.lastVerdict = '异常（放行）'
      await log(`异常（放行）：${String(e && e.message || e).slice(0, 160)}`)
      return next()                               // ★ fail-open
    }
  })

  /** 公共收尾：判空 / dryRun / 注入。→ 要返回给 DSH 的结果，或 null 表示放行。 */
  async function finish(r, query, tag, next, forceDry) {
    if (!r.ok) {
      stats.errors++
      stats.lastVerdict = '检索失败（放行）'
      if (stats.errors <= 3) await log(`检索失败（放行）：${r.err.slice(0, 160)}`)
      return null
    }
    if (!r.block) {
      stats.skipped++
      stats.lastVerdict = '没有够相关的旧记忆（不注入）'
      return null
    }
    const h = hashStr(r.block)
    if (seenBlocks.has(h)) {
      stats.skipped++
      stats.lastVerdict = '这块已经注入过（去重）'
      return null
    }
    stats.injected++
    stats.lastVerdict = `注入 ${r.block.length} 字（${tag}）`
    if (dryRun || forceDry) {
      // ⚠️ dryRun 期间**不许**把块记进 seenBlocks，否则真开启后这批永远被去重掉
      await log(`[DRY-RUN] 本来会注入 ${r.block.length} 字（${tag}，query=${JSON.stringify(query.slice(0, 80))}）` +
        ` → ${JSON.stringify(r.block.slice(0, 100))}`)
      return null
    }
    seenBlocks.add(h)
    await log(`注入 ${r.block.length} 字（${tag}，query=${JSON.stringify(query.slice(0, 80))}；` +
      `独立消息，他的原话未改动）`)
    // ⚠️ 必须把**完整的**消息列表带上（从空数组起会被当成整段对话只剩这一条）
    return { kind: 'enter', messages: withRecall(payloadMessages, r.block) }
  }

  log(`dsh-recall 启动：enabled=${enabled} dryRun=${dryRun} timeout=${timeoutMs}ms ` +
    `actionTrigger=${actionTrigger} interval=${actionMinIntervalMs}ms maxPerTurn=${actionMaxPerTurn} ` +
    `| 注入方式=独立消息(source.kind=${SOURCE_KIND})`)
}

/** 媒体/图片在飞的时候不插记忆块（会打断看图，同 sessions 里的经验）。 */
function mediaInFlight(messages) {
  if (!Array.isArray(messages)) return false
  const last = messages[messages.length - 1]
  if (!last || !Array.isArray(last.content)) return false
  return last.content.some((b) => b && /image|media/i.test(String(b.type || '')))
}

// 导出纯函数供**脱机单测**（`_tmp\test_recall_plugin.mjs`）——
// 消息整形是这插件最危险的部分（改错 = 每个回合都受影响），必须能单独验。
export { isHumanInput, textOf, recallMessage, withRecall, SOURCE_KIND,
  actionQuery, toolCallOf, isToolResult, lastHumanIndex, hashStr }
