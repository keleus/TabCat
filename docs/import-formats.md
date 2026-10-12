# 外部备份导入格式

`lib/backup.js` 继续完整支持 TabCat 自有格式：根对象的 `format` 必须为
`tabcat`，`version` 必须为 `1`，状态位于 `state`。`parseBackup(text)` 返回
状态对象；`inspectBackup(text, currentState?)` 返回预览结果：

```js
{
  state,
  format: 'tabcat' | 'infinity' | 'itab',
  summary: {
    format,
    sites: { imported, skipped },
    engines: { imported, skipped },
    settings: { imported, skipped },
    foldersExpanded,
    skippedComponents,
    imported,
    skipped,
    mode: 'replace' | 'merge'
  },
  warnings
}
```

TabCat 文件使用 `mode: 'replace'`。Infinity 与 iTab 文件使用
`mode: 'merge'`：在 `currentState` 存在时保留现有状态，追加尚未存在的
HTTP/HTTPS 网站和搜索引擎，并覆盖能够明确对应到 TabCat 的设置（Infinity
仅限图标外观，见下文）。没有传入
`currentState` 时从 TabCat 默认状态开始。导入函数不会修改传入的状态对象。

## Infinity v2

这一格式由用户提供的 Infinity New Tab Pro 11.0.41 参考包核对。参考包中的
`25.js` 实现 `exportJsonFile`，导出的文件内容是普通 JSON，扩展名为
`.infinity`；`14.js` 的本地备份调用构造的根对象为：

```js
{
  version: 'v2',
  browserEnv,
  editionEnv,
  backupType: 'local',
  time,
  extVersion,
  data
}
```

同一包中 `getAllBackupData` 和 `initAutoBackup` 明确了 `data` 的已核对键和
嵌套结构：

- `data.site.sites` 是分页二维数组；网站项目使用 `type: 'web'`、`target`、
  `name`、`uuid`、`bgImage`，文件夹使用 `children`。
- `data.setting.setting` 保存 `view`、`link`、`layout`、`icon`、`search`、
  `font` 等设置。
- `data.searcher.searchEngine` 保存 `custom`、`addList`、`current`、`all`；内置
  引擎的搜索地址位于 `types[0].url`，自定义或附加引擎会在导出转换后使用
  `target`。
- `wallpaper`、`weather`、`todo`、`note` 等组件也会出现在 `data` 中，但
  TabCat 没有对应的数据模型。

导入会展开文件夹，把其中可映射的网站作为平面快捷方式，并在
`foldersExpanded` 和 `warnings` 中报告。`app` 类型、`infinity://` 内部入口、
壁纸、天气、待办、笔记和未识别组件会被跳过。只有 `http:` 和 `https:` 网址
会被保存；`javascript:`、`data:`、扩展内部协议以及含用户名或密码的网址
不会进入状态。

网站项目的 `bgImage` 指向 Infinity 的图标 CDN（`*.infinitynewtab.com`，包括图标库和
云端自定义图标）。默认导入时不保留，TabCat 也不会向该域名请求图片，这些站点与手动
添加的网址一样：先使用网站库内置图标，没有时再从网站自动发现图标。托管在其他域名的
图片地址和内嵌的 `data:image` 图片仍作为备选图标保留。

导入预览提供「保留 Infinity 图标」选项（`inspectBackup(text, state, {
keepInfinityIcons: true })`，仅对 Infinity 备份生效，默认关闭）。勾选后，CDN 地址会
成为站点自己的图标地址（`icon`）：新标签页首次显示时由扩展下载、缩小并缓存在本机，
此后不再访问对方服务器，同步时也只带上这个网址。`summary.infinityIcons` 给出受影响
的站点数和是否保留。

设置方面只导入 `data.setting.setting.icon` 分组，对应 TabCat 的「图标外观」
页：`scale`（乘以 144 得到图标大小）、`radius`（乘以 48 后按图标边长换算为百分比
圆角）、`opacity`（乘以 100）和 `isHideIconName`（取反为名称显示）。`layout`
行列与间距、`search`、`link` 打开方式、`view`、`font` 以及 `data.wallpaper`
都不导入，避免覆盖用户已在 TabCat 排好的桌面；导入预览会在 `warnings` 中说明
这一点，不宣称全量兼容。

## iTab

iTab 结构依据当前公开页面 `https://go.itab.link` 的 HTML（引用
`./assets/main-xk0K4irq.js`）及其公开静态脚本核对。当前前端默认配置和配置
同步代码确认了这些顶层键：

```js
{
  baseConfig: {
    searchEngine, useSearch, search, theme, sidebar, wallpaper,
    layout, time, open, icon, topSearch
  },
  navConfig,
  notes,
  todo,
  todoFolder,
  stocks,
  exchangerate
}
```

`navConfig` 的页面项包含 `children`，快捷方式常见字段为 `url`、`type`、
`name`、`src`，文件夹项使用 `type: 'folder'` 和 `children`。`baseConfig` 中
的 `searchEngine` 使用 `key`、`title`、`href`，当前引擎由 `useSearch` 指定。
也接受公开同步接口使用的 `iTabConfig` JSON 字符串包装，但字符串解析后仍须
包含已核对的 `baseConfig` 或 `navConfig`。

导入会展开明确标记的文件夹，导入可映射的网站、搜索引擎、主题、壁纸地址、
搜索框、时间、图标和开关设置。笔记、待办、待办文件夹、股票、汇率、工具
组件及未知顶层键会在 `skippedComponents` 和 `warnings` 中列出。页面分组本身
不计作用户文件夹。搜索地址只在补上 `%s` 后仍是 HTTP/HTTPS 地址时导入。

## 安全边界与验证

解析器只调用 `JSON.parse`，不执行输入中的脚本或表达式；拒绝超过 20 MiB 的
文本、未知格式和标记为加密的内容。外部导入使用白名单字段映射，未知字段不
会写入 TabCat 状态。恶意或无法识别的 URL 项会被跳过并计入摘要，避免一次
坏链接污染现有状态。

真实结构样例位于：

- `tests/fixtures/imports/infinity-v2.json`
- `tests/fixtures/imports/itab-config.json`

`tests/backup.test.js` 覆盖 TabCat round-trip、两个外部结构的导入、文件夹展开、
组件跳过、恶意 URL、未知/加密/超大文件，以及传入状态不被修改。

TabCat 新版状态携带 `iconRadiusUnit: "percent"`，图标圆角范围为 0–50%。没有该标记的旧 TabCat 数据按像素换算一次；Infinity / iTab 适配器中的像素圆角按导入后的图标边长换算。文字图标字体样式和已删除的内置入口状态随 TabCat JSON 完整保存。
