# opentracks-bgm

一个用于 [OpenTracks（旧 DOVA-SYNDROME，opentracks.com）](https://opentracks.com/) 免费 BGM 库的选曲技能（Agent Skill）。

站内有 19,000+ 首免费 BGM，但检索依赖「情绪 × 节奏曲风 × 使用乐器」三维标签，**同组标签是 AND 交集**——自己叠加标签很容易叠到 0 结果，或叠出一堆不相关的曲子。这个技能把「我想要那种……的感觉」自动拆成标签组合 + 关键词 + 语义查询三条线，合并去重、打分，输出候选表和一个可连续试听的本地页面。

> An Agent Skill that turns fuzzy music briefs into effective searches on OpenTracks (formerly DOVA-SYNDROME), then renders a local audition page.

## 能力

- **标签拆分**：按 `references/tags.md` 把中文/英文的模糊描述拆成站内真实存在的 `m/r/i` 标签组合（可多组并行）
- **三线并行检索**：多组标签交集 + 关键词检索 + 站内 AI 语义检索，脚本内部合并去重
- **打分排序**：命中次数、标签吻合度、简介里的风格关键词、下载量、时长/循环/人声约束
- **人工复核闭环**：输出简介与标签，复核后用 `--only` 只保留通过的曲子
- **相似曲扩展**：给一首喜欢的曲子（`--seed <id>`），按简介文本 + 曲风标签集合做相似度排序
- **可连续试听**：生成 `shortlist.html`，内嵌播放器（**互斥播放**，播一首自动停其他）、详情页/下载页链接、一键复制链接；可把 mp3 落盘离线听

## 环境要求

- **Node ≥ 18**（使用内置 `fetch`）
- 零 npm 依赖、零配置、无需登录/Cookie
- Windows / macOS / Linux 通用

## 安装

把整个文件夹放到 Agent 的技能目录：

```bash
# macOS / Linux
cp -r opentracks-bgm-skill ~/.agents/skills/opentracks-bgm

# Windows (PowerShell)
Copy-Item -Recurse opentracks-bgm-skill "$HOME\.agents\skills\opentracks-bgm"
```

也可以直接把本仓库克隆进 `~/.agents/skills/opentracks-bgm`。

## 用法

```bash
node "$HOME/.agents/skills/opentracks-bgm/scripts/opentracks.mjs" search \
  --keyword "ケルト" --keyword "アイリッシュ" --kw-pages 3 \
  --query "陽気なケルト フィドル ティンホイッスル リール" \
  --query "ケルト ハープ 静か 物悲しい" \
  --query "凯尔特 爱尔兰 民族乐器 欢快 舞曲" \
  --tags r18,i10 --tags r18,i14 --tags m06,r18 \
  --tag-pages 2 --pages 2 --pool 16 \
  --out "./bgm-picks/celtic" --audio
```

命令列表：

```
search  --query <文本>        站内 AI 语义检索，可重复（中文/日文/英文均可）
        --keyword <词>        关键词检索，可重复；风格词不在标签里时用它
        --tags m04,r17        标签交集（AND），可重复，每次一组独立组合
        --only 8843,5945      复核后只保留这些曲目 ID
        --seed <曲目ID>       以某首曲子为种子做相似扩展
        --duration 60-180     时长（秒）
        --loop yes|no         是否可循环
        --vocal no            排除人声/合唱
        --kind bgm|jingle     素材类型
        --pages / --kw-pages / --tag-pages   各线路翻页数（每页只有 5 条）
        --pool 12             输出条数
        --out <目录>          生成 shortlist.html
        --audio               把试听 mp3 下载到 <目录>/audio
        --json <文件>         落盘完整结果
detail <曲目ID>               打印单曲完整元数据
similar <曲目ID>              站内相似曲 10 首
```

## 推荐工作流

1. 判断需求是「精确标签」（钢琴、无鼓、1 分钟）还是「模糊感觉」（凯尔特、北欧、赛博）
2. 模糊需求先做**标签拆分**，产出 2–3 组 `m/r/i` 组合
3. 同一命令里跑「多组标签 + 关键词 + 语义」三条线
4. **人工剔除**：逐条看简介与标签，剔除风格不对的，再用 `--only` 重建清单
5. 交付 Markdown 表 + `shortlist.html` 试听页

详细步骤见 [SKILL.md](SKILL.md)，标签码表见 [references/tags.md](references/tags.md)。

## 目录结构

```
SKILL.md                    技能主文档（工作流 + 命令参考）
references/tags.md          站内标签码对照表（情绪/曲风/乐器 + 中文语感）
scripts/opentracks.mjs      检索、解析、打分、生成试听页
```

## 已知限制

- 排名基于元数据（标签、简介、时长、下载量），**没有音频特征分析**，最终仍需要人耳判断
- 站内每页仅 5 条结果，深翻收益递减
- 试听 mp3 直链带短时效签名（约 30 分钟），留档请用 `--audio` 落盘
- 站点为服务端渲染，靠 HTML 解析；站点改版可能导致解析失效

## 免责声明

本仓库只包含检索工具代码，**不包含任何音乐素材**。所有音频版权归 OpenTracks 及各作曲者，使用请遵守 [OpenTracks 许可与利用规约](https://opentracks.com/help/articles/license/) 及作者各自的利用条件（不少作者要求署名）。下载的音频建议仅用于选曲试听。

## License

[MIT](LICENSE)
