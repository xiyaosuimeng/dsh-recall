# dsh-recall —— 每轮自动把旧记忆递到眼前

**第 4 步**（攻克"记忆不像脑子"的最后一环）。前三步解决"**记忆能被找到**"：
- `tools\scenes.py` 场景触发表（说出词就想起）
- `startup.py ③b` 状态快照（开局先看状态）
- `tools\semantic.py` 语义检索（换个说法也搜得到）

但它们都是**开局检索一次**。聊到第二小时话题飘了，后面的记忆不会自己来。
这个插件把它变成：**你说一句话，相关的旧记忆自己送到。**

---

## 🔴 三条设计红线（一条都别碰）

### 1. 只往消息列表"尾巴"追加，绝不动系统提示
前缀缓存的规则是**从头一模一样才算命中**（实测我们 99.36% 的读都是缓存）。
动开头 = 整条缓存作废 = **费用可能涨十倍**。
所以：注入**加在消息列表末尾**，历史和他说的话前面一个字节不动。

### 2. 独立消息，但**他的原话一个字节都不改**（2026-10-22 修订）
> 旧版是"追加到他那条 user 消息的 content 末尾"——前缀缓存同样没事，但
> 他看到的是「**我的话里带着一堆资料**」。原话：
> 「能不能做成随我的指令直接回忆记忆而不是直接种在我的指令里」。

现在改为**追加一条独立的注入消息**（`persona-continuity` 的开局块已验证这条路可行）：
- `id`：`randomUUID()` —— **漏了它会话落盘后下次加载校验失败、整个会话打不开**（2026-10-13 踩过）
- `source.kind`：`'dsh-recall'` —— 非空，满足 `producer-owned source kind`（2026-10-16 踩过）
- `role: 'user'`、`content` 必须是数组 —— 形状要求

⇒ **他的消息对象与 id 全部原样保留**，单测逐字节断言（`_tmp\test_recall_plugin.mjs`）。

### 3. 默认 `dryRun: true`
这是"**每轮都跑**"的插件，出错代价最大。dryRun 期间它只往
`_tmp\recall_plugin.log` 写"我本来会注入什么"，**不碰消息内容**。

---

## 安全阀一览

| 阀 | 在哪 | 作用 |
|---|---|---|
| `enabled` | `cordis.patch.yml` | 总开关 |
| `dryRun` | 同上（**默认 true**）| 只记日志不注入 |
| 阈值 `MIN_SCORE` | `tools\recall_once.py` | 不够相关**什么都不返回**（宁缺勿滥）|
| 条数/长度上限 | 同上 | 最多 3 条 / 900 字（塞太多会淹掉关键信息）|
| 同一条消息只注入一次 | 插件内 `done` 集合 | pre-step 重入时不会重复塞 |
| 超时 8 秒 | 插件 config | 超时→放行，不阻塞对话 |
| 任何异常 → 放行 | 插件 try/catch | **fail-open**，绝不连累对话 |
| 脱敏 | `recall_once.py` | 出块前再打一遍 `sk-`/token |

## 怎么验证

```powershell
$node = 'node'
& $node --check %DSH_WORKSPACE%\dsh-plugins\dsh-recall\index.js          # 语法
& $node %DSH_WORKSPACE%\_tmp\test_recall_plugin.mjs                      # 纯函数单测 5/5（2026-10-22 重写）
& $py __RECALL_SCRIPT__ --selftest                    # 检索器自检 8/8
& $py __RECALL_SCRIPT__ "怎么让一张图片动起来"          # 该注入
& $py __RECALL_SCRIPT__ "今天天气挺好的"                # 不该注入（空输出）
```

看它实际干了什么：`%DSH_WORKSPACE%\_tmp\recall_plugin.log`

## 怎么开真注入

1. 先让它 **dryRun 跑一段**（几天），看日志里"本来会注入"的东西**判准对不对**
2. 确认没问题，再把 `cordis.patch.yml` 里 `dryRun: false`
3. **重启 DSH** 生效

## 怎么撤

```powershell
# 删掉 profile 里那一行（或整个插件）
plugin_manager remove_bundle target=dsh-recall
```
或者把 `cordis.patch.yml` 的 `enabled: false`。
