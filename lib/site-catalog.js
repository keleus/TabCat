import sources from '../public/catalog/sources.json' with { type: 'json' };
import { BUILTIN_SITES } from './defaults.js';
import { normalizeUrl, pinSite } from './state.js';

export const CATALOG_CATEGORIES = [
  ['all', '全部'], ['browser', '内置快捷方式'], ['social-cn', '国内社交'], ['social-global', '海外社交'],
  ['ai-cn', '国内 AI'], ['ai-global', '海外 AI'], ['reading', '资讯阅读'],
  ['video', '影音娱乐'], ['work', '效率办公'], ['dev', '开发设计'], ['search', '搜索学习'], ['life', '购物生活'],
];

// Bundled metadata keeps browsing and searching the library available offline.
const websites = [
  ['xiaohongshu', '小红书', 'https://www.xiaohongshu.com/', 'social-cn', '生活分享与兴趣社区', 'rednote xhs 小红书'],
  ['weibo', '微博', 'https://weibo.com/', 'social-cn', '动态分享与热点话题', 'weibo 微博'],
  ['douyin', '抖音', 'https://www.douyin.com/', 'social-cn', '短视频与直播', 'douyin 抖音'],
  ['kuaishou', '快手', 'https://www.kuaishou.com/', 'social-cn', '短视频与生活分享', 'kuaishou 快手'],
  ['tieba', '百度贴吧', 'https://tieba.baidu.com/', 'social-cn', '兴趣讨论与交流', 'tieba 贴吧'],
  ['wechat', '微信网页版', 'https://wx.qq.com/', 'social-cn', '微信网页聊天', 'wechat weixin 微信'],
  ['qzone', 'QQ空间', 'https://qzone.qq.com/', 'social-cn', '动态与相册分享', 'qzone qq 空间'],
  ['x', 'X', 'https://x.com/', 'social-global', '动态分享与实时讨论', 'twitter 推特 x'],
  ['instagram', 'Instagram', 'https://www.instagram.com/', 'social-global', '照片与短视频分享', 'instagram ins ig'],
  ['facebook', 'Facebook', 'https://www.facebook.com/', 'social-global', '好友动态与社群', 'facebook 脸书'],
  ['threads', 'Threads', 'https://www.threads.com/', 'social-global', '文字动态与话题交流', 'threads 串串'],
  ['reddit', 'Reddit', 'https://www.reddit.com/', 'social-global', '社区话题与讨论', 'reddit 红迪'],
  ['tiktok', 'TikTok', 'https://www.tiktok.com/', 'social-global', '短视频与创作者社区', 'tiktok 国际版抖音'],
  ['linkedin', 'LinkedIn', 'https://www.linkedin.com/', 'social-global', '职业交流与行业动态', 'linkedin 领英'],
  ['discord', 'Discord', 'https://discord.com/app', 'social-global', '社区聊天与语音交流', 'discord 社群'],
  ['telegram', 'Telegram', 'https://web.telegram.org/', 'social-global', '即时聊天与频道', 'telegram 电报 tg'],
  ['bluesky', 'Bluesky', 'https://bsky.app/', 'social-global', '动态分享与开放社交', 'bluesky 蓝天'],
  ['pinterest', 'Pinterest', 'https://www.pinterest.com/', 'social-global', '图片灵感与收藏', 'pinterest pin'],
  ['deepseek', 'DeepSeek', 'https://chat.deepseek.com/', 'ai-cn', 'AI 对话与推理助手', 'deepseek 深度求索 ai'],
  ['doubao', '豆包', 'https://www.doubao.com/chat/', 'ai-cn', 'AI 对话与创作助手', 'doubao 豆包 ai'],
  ['kimi', 'Kimi', 'https://www.kimi.com/', 'ai-cn', 'AI 问答与文档分析', 'kimi 月之暗面 ai'],
  ['qianwen', '千问', 'https://www.qianwen.com/', 'ai-cn', 'AI 问答与创作助手', 'qwen 通义 千问 阿里 ai'],
  ['yuanbao', '腾讯元宝', 'https://yuanbao.tencent.com/', 'ai-cn', 'AI 问答与内容创作', 'yuanbao 元宝 tencent ai'],
  ['chatglm', '智谱清言', 'https://chatglm.cn/', 'ai-cn', 'AI 对话与写作助手', 'glm 智谱 清言 zhipu ai'],
  ['wenxiaoyan', '百度文心', 'https://wenxin.baidu.com/', 'ai-cn', 'AI 搜索与创作助手', '文心一言 文小言 ernie baidu ai'],
  ['xinghuo', '讯飞星火', 'https://xinghuo.xfyun.cn/', 'ai-cn', 'AI 问答与办公助手', '讯飞 星火 xinghuo iflytek ai'],
  ['chatgpt', 'ChatGPT', 'https://chatgpt.com/', 'ai-global', 'AI 对话与创作助手', 'chatgpt openai gpt ai'],
  ['claude', 'Claude', 'https://claude.ai/', 'ai-global', 'AI 写作、分析与编程', 'claude anthropic ai'],
  ['gemini', 'Gemini', 'https://gemini.google.com/', 'ai-global', 'Google AI 助手', 'gemini google 谷歌 ai'],
  ['copilot', 'Microsoft Copilot', 'https://copilot.microsoft.com/', 'ai-global', '微软 AI 助手', 'copilot microsoft 微软 ai'],
  ['perplexity', 'Perplexity', 'https://www.perplexity.ai/', 'ai-global', 'AI 搜索与资料研究', 'perplexity pplx ai'],
  ['grok', 'Grok', 'https://grok.com/', 'ai-global', 'AI 问答与内容创作', 'grok xai x.ai ai'],
  ['poe', 'Poe', 'https://poe.com/', 'ai-global', '多模型 AI 对话平台', 'poe quora ai'],
  ['lechat', 'Mistral AI', 'https://chat.mistral.ai/', 'ai-global', 'Mistral AI 对话助手', 'mistral le chat vibe ai'],
  ['notebooklm', 'NotebookLM', 'https://notebooklm.google.com/', 'ai-global', '基于资料的 AI 阅读与整理', 'notebooklm google 笔记 ai'],
  ['huggingface', 'Hugging Face', 'https://huggingface.co/', 'ai-global', 'AI 模型与应用社区', 'hugging face hf 模型 ai'],
  ['midjourney', 'Midjourney', 'https://www.midjourney.com/', 'ai-global', 'AI 图像创作', 'midjourney mj 绘画 ai'],
  ['suno', 'Suno', 'https://suno.com/', 'ai-global', 'AI 音乐创作', 'suno 音乐 ai'],
  ['elevenlabs', 'ElevenLabs', 'https://elevenlabs.io/', 'ai-global', 'AI 语音与音频创作', 'elevenlabs 配音 语音 ai'],

  ['sspai', '少数派', 'https://sspai.com/', 'reading', '数字生活与效率工具', 'ssp 少数派效率'],
  ['zhihu', '知乎', 'https://www.zhihu.com/', 'reading', '问答与知识分享', 'zhihu'],
  ['36kr', '36氪', 'https://36kr.com/', 'reading', '科技与商业资讯', '36kr 科技'],
  ['ithome', 'IT之家', 'https://www.ithome.com/', 'reading', '科技新闻与数码资讯', 'it home'],
  ['douban', '豆瓣', 'https://www.douban.com/', 'reading', '书影音与兴趣社区', 'douban'],
  ['bilibili', '哔哩哔哩', 'https://www.bilibili.com/', 'video', '视频与兴趣社区', 'bilibili b站 哔哩'],
  ['youtube', 'YouTube', 'https://www.youtube.com/', 'video', '视频与创作者频道', '油管 youtube'],
  ['iqiyi', '爱奇艺', 'https://www.iqiyi.com/', 'video', '影视与综艺', 'iqiyi'],
  ['qqvideo', '腾讯视频', 'https://v.qq.com/', 'video', '影视与综艺', 'tencent video'],
  ['music163', '网易云音乐', 'https://music.163.com/', 'video', '音乐与歌单', 'netease music'],
  ['notion', 'Notion', 'https://www.notion.so/', 'work', '笔记与协作文档', '笔记 notion'],
  ['yuque', '语雀', 'https://www.yuque.com/', 'work', '知识库与文档', 'yuque'],
  ['feishu', '飞书', 'https://www.feishu.cn/', 'work', '团队协作与办公', 'feishu lark'],
  ['qqdocs', '腾讯文档', 'https://docs.qq.com/', 'work', '在线文档与表格', 'tencent docs'],
  ['gmail', 'Gmail', 'https://mail.google.com/', 'work', 'Google 邮箱', '邮件 gmail'],
  ['outlook', 'Outlook', 'https://outlook.live.com/', 'work', '微软邮箱', '邮件 microsoft outlook'],
  ['github', 'GitHub', 'https://github.com/', 'dev', '代码托管与开源社区', 'git github'],
  ['gitlab', 'GitLab', 'https://gitlab.com/', 'dev', '代码托管与开发协作', 'git gitlab'],
  ['gitee', 'Gitee', 'https://gitee.com/', 'dev', '代码托管与开源社区', '码云 gitee'],
  ['mdn', 'MDN Web Docs', 'https://developer.mozilla.org/', 'dev', 'Web 开发文档', 'mdn javascript css html'],
  ['stackoverflow', 'Stack Overflow', 'https://stackoverflow.com/', 'dev', '编程问答', 'stack overflow 编程'],
  ['figma', 'Figma', 'https://www.figma.com/', 'dev', '界面设计与协作', 'figma ui 设计'],
  ['canva', 'Canva 可画', 'https://www.canva.com/', 'dev', '图文设计', 'canva 可画'],
  ['google', 'Google', 'https://www.google.com/', 'search', '搜索信息与网页', '谷歌 google'],
  ['bing', 'Bing', 'https://www.bing.com/', 'search', '搜索信息与网页', '必应 bing'],
  ['baidu', '百度', 'https://www.baidu.com/', 'search', '搜索信息与网页', 'baidu'],
  ['wikipedia', '维基百科', 'https://www.wikipedia.org/', 'search', '开放百科全书', 'wiki wikipedia'],
  ['coursera', 'Coursera', 'https://www.coursera.org/', 'search', '在线课程', 'coursera 学习'],
  ['mooc', '中国大学 MOOC', 'https://www.icourse163.org/', 'search', '大学课程与在线学习', '慕课 mooc'],
  ['taobao', '淘宝', 'https://www.taobao.com/', 'life', '购物与生活好物', 'taobao'],
  ['jd', '京东', 'https://www.jd.com/', 'life', '购物与生活服务', 'jingdong jd'],
  ['tmall', '天猫', 'https://www.tmall.com/', 'life', '品牌购物', 'tmall'],
  ['amap', '高德地图', 'https://www.amap.com/', 'life', '地点搜索与路线规划', 'amap gaode 地图'],
  ['12306', '铁路 12306', 'https://www.12306.cn/', 'life', '铁路出行', '火车 高铁 12306'],
  ['ctrip', '携程', 'https://www.ctrip.com/', 'life', '旅行与酒店', 'ctrip 旅游'],
];
const builtinDescriptions = {
  bookmarks: ['管理浏览器收藏与文件夹', '收藏 书签 bookmarks'],
  history: ['查看浏览过的网页', '历史 history'],
  extensions: ['管理已安装的扩展和插件', '插件 扩展 extensions'],
  downloads: ['查看下载内容与文件', '下载 downloads'],
  settings: ['打开浏览器偏好设置', '设置 settings'],
};
export const SITE_CATALOG = [
  ...BUILTIN_SITES.map(site => ({ ...site, category: 'browser', description: builtinDescriptions[site.builtin][0], keywords: builtinDescriptions[site.builtin][1] })),
  ...websites.map(([id, name, url, category, description, keywords]) => ({ id, name, url, category, description, keywords, iconPath: ['page-logo', 'brand-artwork', 'brand-fallback', 'hd-favicon'].includes(sources[id]?.kind) ? `/catalog/${sources[id].file}` : '', iconKind: sources[id]?.kind, iconBackground: sources[id]?.background || '#ffffff', defaultImageScale: ['github', 'youtube', 'gmail'].includes(id) ? 75 : 100 })),
];
export function searchCatalog(query = '', category = 'all') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return SITE_CATALOG.filter(site => (category === 'all' || site.category === category) && words.every(word => `${site.name} ${site.url} ${site.description} ${site.keywords}`.toLocaleLowerCase().includes(word)));
}
function websiteKey(value) {
  const normalized = normalizeUrl(value); if (!normalized) return '';
  const url = new URL(normalized); url.hostname = url.hostname.replace(/^www\./, '');
  return url.href;
}
export function catalogSiteAdded(sites, entry) {
  return sites.some(site => entry.builtin ? site.builtin === entry.builtin : !site.builtin && websiteKey(site.url) === websiteKey(entry.url));
}
export function pinCatalogSite(state, id) {
  const entry = SITE_CATALOG.find(site => site.id === id);
  if (!entry) throw new Error('此快捷方式不在网站库中');
  if (catalogSiteAdded(state.sites, entry)) return { state, duplicate: true };
  if (!entry.builtin) return pinSite(state, entry);
  const builtin = BUILTIN_SITES.find(site => site.builtin === entry.builtin);
  const site = { ...builtin, id: state.sites.some(site => site.id === builtin.id) ? crypto.randomUUID() : builtin.id };
  return { state: { ...state, sites: [...state.sites, site] }, site, duplicate: false };
}

// Resolve only catalog hosts, never user-supplied local paths. This also gives
// previously saved shortcuts the bundled artwork without changing their data.
function catalogEntry(value) {
  let host;
  try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) return ''; host = url.hostname.replace(/^www\./, ''); } catch { return ''; }
  const aliases = { 'twitter.com': 'x.com', 'threads.net': 'threads.com', 'notion.com': 'notion.so', 'kimi.moonshot.cn': 'kimi.com', 'yiyan.baidu.com': 'wenxin.baidu.com' };
  host = aliases[host] || host;
  return SITE_CATALOG.find(site => !site.builtin && new URL(site.url).hostname.replace(/^www\./, '') === host);
}

export function catalogIcon(value) { return catalogEntry(value)?.iconPath || ''; }

export function catalogIconBackground(value, path) { const entry = catalogEntry(value); return path && path !== entry?.iconPath ? sources[entry?.id]?.logoFallback?.background || '#ffffff' : entry?.iconBackground || '#ffffff'; }

export function catalogFavicon(value) { const entry = catalogEntry(value); return entry?.iconKind === 'hd-favicon' ? entry.iconPath : ''; }

export function catalogLogo(value) { const entry = catalogEntry(value); return entry?.iconKind === 'page-logo' || entry?.iconKind === 'brand-artwork' ? entry.iconPath : sources[entry?.id]?.logoFallback ? `/catalog/${sources[entry.id].logoFallback.file}` : ''; }

export function siteImageScale(site) {
  if (site.imageScale != null && site.imageScale !== '') return Number(site.imageScale);
  return !site.icon && !site.iconText ? catalogEntry(site.url)?.defaultImageScale || 100 : 100;
}
