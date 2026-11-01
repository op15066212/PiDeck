# 渲染层虚拟化审计

> **Status: Historical（2026-10-31 归档；测试固定读取此路径，内容记录当时审计，不代表现状）**


> 判据 + 现状登记。判定标准是长期资产，具体行数/接入点数量会变——变的东西不写死在这里，
> 由 `tests/scrollContainerGuard.mjs` 现算（`node tests/scrollContainerGuard.mjs`）。

## 一、什么时候该虚拟化

两个条件**同时**成立：

1. **有自己的滚动视口**——容器上有 `max-h-*` / `h-*` 且有 `overflow-y-auto`（含 flex 填充的滚动窗）。
2. **行数随数据增长**——不是受控分页、不是固定枚举、不是一次性弹窗。

缺第 1 条就没有「窗口」这个概念，算不出该挂哪几行；缺第 2 条虚拟器自身的开销（一条
ResizeObserver + 每帧行集合计算）比直接渲染几个 div 更贵。

## 二、行高方差不是判据（这条曾经写错过）

早期版本写的是「行高方差 > 2 倍不用虚拟化，改用挂载预算」。**归因错了。**

那次失败（执行过程组体套虚拟栈后「展开方向反了」）的真因是**纯估值**：
`estimateSize` 固定返回 40px，行位置全按估值算，而真实行高从 28px 到几百 px。

正确判据：

| 行高怎么定 | 适合的行高分布 |
| --- | --- |
| 纯估值（`estimateSize` 常数） | 方差小；方差 > 2 倍必然错位 |
| 实测（`measureElement` + ResizeObserver） | 任意分布 |

**红线只有一条：虚拟化必须配 `measureElement`。** `VirtualStack` 的默认行为就是实测。

所以「含可展开块的列表不能虚拟化」这句话是错的——折叠区（组头 32px / 展开组 352px /
中间回复几百 px）就是靠实测接进去的。

## 三、接入点

通用件：`src/renderer/src/components/ui-shadcn/virtual-stack.tsx`。

- 行数 ≤ `minRows`（默认 16）时直出 Fragment，DOM 与接入前逐字一致；
- 接入点只描述「怎么画一行」，不写测量/缓存代码；
- 虚拟行是 `absolute`，**不参与 flex 布局**，原来靠父容器 `gap` 提供的行距会消失
  → 用 `rowClassName` 补（例如 `pb-2`）。漏了的表现是行贴在一起，一眼可见。

## 四、明确的例外与理由

标记写在滚动窗**容器这一行之上**（中间可隔最多 13 行的多行属性）。三条边界，违反任一条都不算豁免：

1. 写在容器**下方**等于没写（守卫只向上找）；
2. 向上查找**遇到上一个元素的开标签收尾**（`>` 或 `/>`）就停 —— 标记写在别的元素上时，不会顺带豁免它下方的容器；
3. 类别名必须在白名单内（`tests/scrollContainerGuard.test.mjs` 会把本表与代码里的 `EXEMPT_CATEGORIES` 逐项比对，两边不同就红）。

`scroll-ok: <类别>`，六类：

| 类别 | 含义 | 典型场景 |
| --- | --- | --- |
| `bounded` | 行数有硬上限 | 受控分页（每次 +30）、固定枚举、短预览 |
| `transient` | 一次性弹窗/表单 | 设置页各 tab、反馈弹窗、Dropdown 菜单 |
| `nested` | 嵌套树，需先扁平化 | 目录→文件两层、两段异质列表混在一个滚动窗 |
| `flip` | 有退场动画，卸载会失去锚点 | `RemovalRow` 的 FLIP 淡出 |
| `probe` | 探针/守卫自测用 | 测试夹具 |
| `text` | 单一文本块，没有「行列表」可虚拟化 | 原始 JSON `<pre>`、复制出来的记录正文 |

## 五、守卫

```bash
node tests/scrollContainerGuard.mjs          # 检查（新增未判定项 exit 1）
node tests/scrollContainerGuard.mjs --list   # 只列未判定
node tests/scrollContainerGuard.mjs --seed   # 重新生成基线
```

三种合法状态：**接线**（容器带一个 ref，同一个 ref 名作为 `scrollRef` 传给 `<VirtualStack>`）/ 写 `scroll-ok:` / 已登记进基线。

「接线」是 2026-10 收紧后的判据，之前的判据是「同文件 ±80 行内出现过 `<VirtualStack>`」——那样两种真缺陷都能过关：接了但容器没 ref（虚拟器拿不到 `scrollElement`，视口恒 0、一行不渲染），以及压根没接却挨得近（永久逃出判定面）。现在判据要求同名 ref 两头都在，`props.` 开头的透传 ref 不算（透传无法静态证明调用方给了实 ref，要在组件内 `props.scrollRef ?? localRef` 兜底）。

基线是**台账**，不是免罪金牌——判定掉一个就把它的指纹删掉，让基线只减不增。
`tests/scrollContainerGuard.test.mjs` 把它接进 `npm test`，并额外守一条：扫描器自身
必须有产出（> 100 个容器、至少一个已虚拟化），防止正则被改坏导致「永远 0 命中、永远绿」。

## 六、已知限制

- **虚拟行离屏即卸载**：行内展开态（哪个组打开着）会随滚动丢失。这是虚拟化的固有代价，
  不是 bug。需要保住的展开态必须提到组件 state（按 id 记），不能放在行内 `useState`。
- **键盘导航/焦点**：离屏行没有 DOM，`querySelector` 与 `.focus()` 会静默变成 no-op。
  用 `virtualizerRef.scrollToIndex` 先把行拉进视口再操作（见 `SessionFindOverlay`、分支树）。
- **`role="list"` / `role="tree"`**：虚拟化会插入一层内容盒，`listitem` 的 owner 变了。
  两种写法都合法，选哪种看短列表路径：
  1. `containerProps={{ role: "list" }}` —— role 落在内容盒上（轨迹视图、子代理条、会话内查找、分支树用这个）；
  2. role 挂在**外层容器**上 —— 内容盒是无 role 的 generic div，在 a11y 树里透明，`listitem` 的 owner 仍然是它（待办条、队列条用这个）。
  选 2 的理由是短列表零 DOM 变化：`containerProps` 一旦传入，短列表也会多包一层 `<div>`（`virtual-stack.tsx` 短列表分支），
  而这两条的短列表本来是 `ul > li`，多一层就是「为了虚拟化改短列表的 DOM」——正是本补丁极力避免的。
  判据：**如果短列表是 `ul`/`ol`，role 不要传 `containerProps`（外层容器已经是 list）；如果短列表也是 `div`，用 `containerProps`。**


## 七、2026-11 全量审计结论

目标：不只是「未判定归零」，而是「会随数据无限变长的滚动窗，逐个判过」。

盘点结果（`node tests/scrollContainerGuard.mjs`）：

```text
滚动容器 166 个：已虚拟化 14 · 已豁免 19 · 基线存量 133 · 未判定 0
```

本轮新增接入：

| 接入点 | 为什么必须 | 行高 |
| --- | --- | --- |
| `components/agents/file-diff.tsx` | 一个文件的 diff 几千行是常态，每行一个 `AgentCodeLine` | 固定 20px（`leading-5` + `whitespace-pre` 不折行） |
| `web/WebFilePreview.tsx` 行号文本 | 网页版打开大文件，整篇逐行渲染 | 可变（`pre-wrap` 折行），靠实测 |

本轮新增豁免（附判据，不是「看着不多」）：

| 位置 | 类别 | 判据 |
| --- | --- | --- |
| `ui-shadcn/notice-history-dialog.tsx` 表格 | `bounded` | 自带分页：`rows = filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE)`，一页行数封顶 |
| `app/ProviderLoginModal.tsx` 事件日志 | `transient` | 生命周期等于一次登录弹窗，条数由 pi 的几步事件决定（几十条） |
| `web/WebFilePreview.tsx` markdown 预览 | `text` | 整篇交给 `MarkdownStream`，按行切会拆散标题/代码块/列表结构与复制语义 |

扫描器本轮修掉的两处假判：

1. **变量声明冒充容器**：`const scrollClass = "overflow-auto"` 含 `overflow-` 字面量，曾被当成滚动容器；
   真正的容器行（类名取自变量、本行没有字面量）反而扫不到，基线上留的是假指纹。
   现在跳过「不含 `<` 的声明行」，单行 JSX 里的容器仍会扫到（`scrollContainerGuard.test.mjs` 有对应用例）。
2. **类名抽成变量就看不见**：`file-diff` 的容器行改为内联三元，不再经 `scrollClass` 中转。

基线里仍然「会变长、但本轮没接」的 5 处，以及它们卡在哪：

| 位置 | 卡点 |
| --- | --- |
| `sidebar/SidebarContent.tsx` → `ProjectTree` | 嵌套树（项目 → 分组 → 会话），要先压平成一维行序列才能接栈 |
| `web/WebTimeline.tsx` 消息流 | 三处依赖真实 DOM：`#web-msg-<id>` 锚点跳转、前插时的原生 scroll anchoring、贴底判定 |
| `web/WebSidebar.tsx` 会话树 | 同 ProjectTree |
| `web/WebWorkspaceDrawer.tsx` 文件树 | 同 ProjectTree |
| `sidebar/AnnouncementCenter.tsx` 已读公告 | 条数受公告发布节奏限制（几十条），暂按 bounded 处理 |

这 5 处是**已知缺口**，不是「判定为不需要」——接之前先解决上表第二列的卡点，否则会退回
「跳转失效」「滚到底反弹」这类已经在时间线上踩过的坑。
