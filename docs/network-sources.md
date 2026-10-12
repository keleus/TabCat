# 网络资源与图标来源

搜索引擎与网站快捷方式使用已核验的清晰 favicon、首页品牌图和矢量备用图。Google 搜索框、切换菜单与搜索引擎设置使用内置 128×128 彩色「G」（`public/search/google.png`），适配紧凑的搜索控件。

搜索建议使用对应提供方的网页接口，已在开发时检查实际返回结构：

- Google：`https://suggestqueries.google.com/complete/search?client=firefox&hl=zh-CN&q=...`
- Bing：`https://api.bing.com/osjson.aspx?query=...&market=zh-CN`
- 百度：`https://suggestion.baidu.com/su?wd=...&ie=utf-8&cb=tabcat`

百度响应按数据提取字符串数组，不插入远程脚本，也不执行 JSONP。三个接口均可能调整或暂时不可达；失败时关闭建议，不阻止用户直接搜索。输入有 240 ms 防抖、200 字限制、过期响应丢弃和中文输入法处理。

Bing 每日壁纸使用 `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN`，加载其 `/th` 图片地址，保留标题、版权说明和本机离线缓存。按北京时间日期缓存每日图片，打开新标签页及保持页面打开时每小时检查。Bing 图片版权属于提供方/标注作者，未作为内置资源重新打包。

快捷方式优先读取 link rel=icon、Apple Touch Icon 和 manifest icons；没有声明时检查网站的 /favicon.ico。先解码再判断实际尺寸，不相信 HTML 中单独声明的 sizes。默认 72 px 图标接受至少 64×64 的 favicon，图案放大或屏幕密度超过 2× 时提高门槛（`max(64, 图标宽度 × 图案比例 / 1.125) × max(1, DPR / 2)` 向上取整）。这是缩略图清晰度筛选，不是逐像素锐度测量；不会把 16/32/48 px 小图当作高清。SVG 可缩放。

favicon 不达标或加载失败时使用页眉、首页链接中的图片及 srcset、内联 SVG、CSS 背景 Logo；缺少 Logo 的深层页面会尝试首页。横向 Logo 完整显示。自动结果缓存一天，无结果十分钟；已选结果按尺寸要求分别缓存，旧版选择缓存失效。用户明确指定的图片或文字优先。书签栏的小图标仍由浏览器提供。

用户填写的图标图片网址由扩展后台下载一次（不带 Cookie 和来源页，限 2 MB，按文件内容判断为 PNG / JPG / WebP / GIF / ICO，网页和 SVG 会被拒绝），缩小到最长边 256 px 后保存在 `chrome.storage.local` 的 `tabcatIconImages`，最多 150 张、约 3 MB，超出时先丢弃最早的。之后直接使用本机副本，网址失效也不受影响；下载失败十分钟内不重试，「重新获取」会再次下载，失败时保留旧副本。浏览器同步只带上网址，不带图片；本机缓存不进入备份。SVG 等无法缓存的地址仍由页面直接加载。从电脑上传的图片同样缩小到 256 px，作为站点的 `icon` 内嵌保存在本机；连接 WebDAV 后由扩展后台上传到用户填写的服务器（`TabCat/icons/`），其他设备从同一服务器下载。WebDAV 请求只带用户填写的账号，不带浏览器 Cookie。

## 网站库本地图标

网站库来源、原始网站、像素尺寸和 SHA-256 记录在 [sources.json](../public/catalog/sources.json)。`hd-favicon` 是已核验且达到普通图标尺寸要求的官网图标；`logoFallback` 保留原有首页/品牌图，用于放大后的回退。`page-logo` 是已核验的官网页面 Logo；`brand-artwork` 是已有品牌图；`brand-fallback` 是取不到官网 Logo 时的 Simple Icons 矢量备用图。其他条目仅保留历史资料，不参与显示。没有可靠素材时显示站点首字。

少数派（64×64）、京东（96×96）及其他 42 个清晰官网图标保留 favicon/应用图标；其中 42 张从先前安装包连同来源和 SHA-256 恢复，尺寸及画面已复核，未放大原图。微博来自官网导航 SVG 的彩色符号；抖音、贴吧、快手、元宝、飞书、12306、携程等使用首页图片。腾讯文档使用页面原始矢量符号。哔哩哔哩保留粉底白色小电视。Simple Icons 许可见 `simple-icons-LICENSE.md`；Midjourney 的 Lobe Icons 许可见 `catalog/lobe-icons-LICENSE`。各网站商标属于对应权利人，仅用于识别快捷方式。

已核验的清晰 favicon 和首页 Logo 从扩展内加载；只有品牌备用图时尝试获取网页图标。编辑窗口支持「重新获取」。内置浏览器功能使用本地 Lucide SVG。

维护图标：安装 Python Pillow 和项目依赖后运行 `python3 scripts/fetch-catalog-icons.py`，或使用 `--ids x,chatgpt` 选择站点。已核验资源会保留。脚本优先检查网页声明的图标，ICO 取最大帧并要求至少 64 px，不足时采集首页 Logo。栅格图最多保存 512 px，绝不放大小图。新结果标为 `candidate-favicon` 或 `candidate-logo`，逐图核验后才可改成 `hd-favicon` 或 `page-logo`。动态页面可在内置浏览器检查实际 Logo，并在 `scripts/catalog-icon-overrides.json` 记录原图 URL 和来源页。`node scripts/bundle-brand-fallbacks.mjs` 可生成有明确来源的离线矢量备用图。成功下载不等于品牌正确。

GitHub、YouTube、Gmail 的默认图案比例为 75%，为图案留出空白；用户已有的手动比例继续优先生效。哔哩哔哩矢量图案由本地维护，抓取脚本不会覆盖。

## 小组件

天气使用 [Open-Meteo 天气 API](https://open-meteo.com/en/docs) 与 [城市搜索 API](https://open-meteo.com/en/docs/geocoding-api)：

- 城市搜索：`https://geocoding-api.open-meteo.com/v1/search?name=...&count=5&language=zh&format=json`，仅在用户点击搜索时发送城市名称，用户选择具体结果。
- 当前天气：`https://api.open-meteo.com/v1/forecast?latitude=...&longitude=...&current=temperature_2m,relative_humidity_2m,weather_code,is_day&daily=sunrise,sunset&forecast_days=2&timeformat=unixtime&timezone=auto`，发送自动定位或手动选择的城市坐标，不申请设备定位。根据返回的 WMO 天气代码与 `is_day` 切换卡片场景（晴、云、阴、雾、雨、雪、雷雨及夜间），未知代码使用中性样式。天气读数、城市坐标和日出日落时间缓存在本机扩展存储，保留最近 20 组坐标读数及自动定位的上次结果；不写入设置备份。打开标签页先渲染缓存，按每小时 00、15、30、45 分钟划分有效期，过期时后台刷新。IP 城市定位使用同一有效期，不保存 IP 地址；同源标签页通过 Web Locks 合并并发刷新。单次请求 8 秒超时，手动刷新会跳过有效期，失败保留旧数据并标注更新时间。组件中保留提供方署名。日夜以 API 返回的城市日出日落时间戳判断，页面可见时每 30 秒检查显示状态，重新显示标签页时立即检查；缺少日出日落数据时采用服务端 `is_day`。夜间晴天月亮按农历日绘制简化月相，仅为装饰示意，不代表精确天文照明比例。
- 两类请求均省略凭据和来源页信息。没有天气组件时不发送天气请求。

网页小组件仅接受 HTTPS URL，当前页可见时首次加载。iframe 使用 `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"` 和 `referrerpolicy="no-referrer"`，不授予顶层导航、下载或扩展 API 权限。远程页面按浏览器第三方存储策略运行，可能向其自身服务发送请求；TabCat 不代理网页，也不移除网站的 X-Frame-Options 或 CSP 限制。备忘仅保存至本机扩展存储，不发送到天气或网页服务。
