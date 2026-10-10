# 默认壁纸来源

项目文件：`public/wallpapers/fjord.png`。

使用内置 image_gen 工具原创生成，未使用 Infinity 插件中的壁纸。此文件随扩展打包，离线可用。

生成提示词：

Use case: photorealistic-natural. Asset type: offline widescreen wallpaper for a minimalist browser new tab extension. Create an original serene landscape photograph, 2560x1440 landscape. Layered distant mountain ridges and a still fjord at blue hour just before sunrise, restrained blue-gray and desaturated teal palette, delicate pale warm glow far right at horizon. Lower left foreground has a small forested headland silhouetted in deep blue. Upper half is an expansive softly graduated misty sky with almost no detail, leaving clean quiet space behind a central white search bar. Mountains occupy lower half, receding into mist, water in lower right. Sophisticated understated desktop wallpaper, cinematic natural light, real photographic textures, soft atmospheric depth, no excessive HDR, no stars, no humans, no buildings, no text, no interface, no logos or watermark. The entire middle 60 percent should have very low visual clutter so circular app icons can be overlaid legibly.


## 在线图库

- Bing 今日沿用 `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN`；最近几日图库读取 `n=8` 的照片，换图避免连续重复。该公开端点的可用性取决于 Bing。
- [Lorem Picsum](https://picsum.photos/) 使用官方 `/v2/list` 接口，筛选宽度至少 1600 px、宽高比至少 1.4 的摄影图片，以 `/id/{id}/1920/1080` 加载；不是按主题筛选的风景专辑，可能包含建筑、人物等摄影内容。
- 设置中保留摄影作者或版权说明以及原图来源链接。图库请求不携带登录凭据；图片成功获取后保留最近一张本地缓存，连接失败使用缓存或内置远山。
- 图库轮换频率随 TabCat JSON 备份保存；远程图片缓存独立存储，不导出。旧的留白、蓝调、松绿、日落预设迁移为内置远山。
