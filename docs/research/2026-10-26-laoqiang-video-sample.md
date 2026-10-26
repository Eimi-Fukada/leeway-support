# 老强说：公开视频样本与统计边界

核对日期：2026-10-26（北京时间）。本轮读取 B 站公开网页与公开 view API，没有登录、付费或绕过风控。视频当前作者 owner/合集 arc.author 均为“老强说”，mid=404192584。

## 数据来源与范围

- 核心样本：公开 view API 返回的 `ugc_season`“财富基础认知”合集，id=3613857，含24集。取该合集全部24条，避免只挑爆款，但不代表该账号全部投稿。
- 种子端点：[公开 view API](https://api.bilibili.com/x/web-interface/view?bvid=BV1nxsFepEcz)，原始响应见 [seed-view.json](evidence/2026-10-26-laoqiang/seed-view.json)。种子由主研究保存，本文件直接复用。
- 补充样本：8条视频逐条调用相同公开 view API，来源于公开列表中与副业测试、模板、旧项目、AI、电商、自媒体有关的题目；其中Notion模板与核心样本是同一BV，不能在汇总时重复计算。
- 采集补充样本UTC时间：2026-10-26T03:16:26.218403+00:00。原始响应见 [supplement-view.json](evidence/2026-10-26-laoqiang/supplement-view.json)，结构化表见 [video-sample.csv](evidence/2026-10-26-laoqiang/video-sample.csv)。
- 播放、点赞、收藏、评论是本轮API返回的累计计数快照，可能随时间变化，不是收入、独立用户、转化率、观看动机或首次发布时的成绩。
- 合集中的 arc.title 与单条 view.data.title 存在不同，例如Notion条目的合集标题为“你开挂了没？”，单条页标题为“送你一套Notion效率模板，开启人生作弊器，从此开挂！”。以下分开标明，不能将其视作独立视频。
- 两个普通列表页分别返回listTotal40和34，且资源index有缺项，因此不声称拿到了账号完整时间线或全部最早视频。样本只能称“当前可核对的2024年8月起的视频”。

## 核心合集24集

以下题目采用 `ugc_season.arc.title`，日期转为北京时间。

| 日期 | 合集内标题 | 播放快照 | 点赞 | 收藏 | 原视频 |
| --- | --- | ---: | ---: | ---: | --- |
| 2024-08-09 | 为什么第1个100万那么难？因为第一件事90%的人都做不到。 | 435,418 | 13,610 | 19,131 | [BV1iLYaeZEoa](https://www.bilibili.com/video/BV1iLYaeZEoa/) |
| 2024-08-10 | 钱的5种来源，这也是富人比你更容易赚钱的原因。你是哪一种类型？ | 236,808 | 5,975 | 7,798 | [BV1hFY7ekEgj](https://www.bilibili.com/video/BV1hFY7ekEgj/) |
| 2024-08-12 | 自古以来赚钱最快的4个方法，快点学起来，很多人从来不知道第3个。 | 205,460 | 5,430 | 6,483 | [BV1j2eFe3EQC](https://www.bilibili.com/video/BV1j2eFe3EQC/) |
| 2024-08-20 | 为什么你无法成为富人，因为这两个概念你根本不懂！ | 172,776 | 4,220 | 2,773 | [BV1owWpeVEQt](https://www.bilibili.com/video/BV1owWpeVEQt/) |
| 2024-08-14 | 普通人做副业如何从0到月入2万？干货教程来了，包含详细执行步骤。 | 203,416 | 7,261 | 7,244 | [BV1c9eJeMERn](https://www.bilibili.com/video/BV1c9eJeMERn/) |
| 2024-08-24 | 如何积累财富？普通人必经的四个阶段，第3阶段有大坑。 | 264,739 | 7,460 | 10,739 | [BV1nxsFepEcz](https://www.bilibili.com/video/BV1nxsFepEcz/) |
| 2024-08-28 | 如何彻底打破穷人思维，第四条会有点意外。 | 122,588 | 6,199 | 4,344 | [BV1BksMeCEfn](https://www.bilibili.com/video/BV1BksMeCEfn/) |
| 2024-08-31 | 真实案例：投资10万，获利1.5亿 | 115,109 | 2,735 | 2,362 | [BV1EUnQe9E5U](https://www.bilibili.com/video/BV1EUnQe9E5U/) |
| 2024-09-11 | 你是个投资者还是个投机者？ | 57,044 | 1,222 | 487 | [BV1uP4YeeEGh](https://www.bilibili.com/video/BV1uP4YeeEGh/) |
| 2024-09-15 | 一个视频解答两个问题：书籍推荐和认知训练 | 66,582 | 2,269 | 2,604 | [BV1No42evERs](https://www.bilibili.com/video/BV1No42evERs/) |
| 2024-10-11 | 你开挂了没？ | 60,553 | 1,719 | 1,141 | [BV19B2mYLETp](https://www.bilibili.com/video/BV19B2mYLETp/) |
| 2024-11-18 | 赚钱认知重构 | 61,399 | 2,184 | 2,183 | [BV1xNUWYBEkk](https://www.bilibili.com/video/BV1xNUWYBEkk/) |
| 2024-12-22 | 终于有人把股票讲清楚了 | 37,751 | 1,296 | 1,161 | [BV1PNkqYWEKh](https://www.bilibili.com/video/BV1PNkqYWEKh/) |
| 2024-12-30 | 怎么理解这个重要的概念？ | 28,020 | 856 | 622 | [BV1NC6VYpE1L](https://www.bilibili.com/video/BV1NC6VYpE1L/) |
| 2024-12-31 | B站财富区最有价值的万人社群长啥样？ | 26,088 | 659 | 361 | [BV1Hs6HYqELy](https://www.bilibili.com/video/BV1Hs6HYqELy/) |
| 2025-02-07 | 关于AI，千万不要一叶障目 | 33,986 | 1,050 | 576 | [BV13nN8ezELF](https://www.bilibili.com/video/BV13nN8ezELF/) |
| 2025-02-21 | 你知道怎么利他么？ | 30,606 | 835 | 657 | [BV1J7AZetEsE](https://www.bilibili.com/video/BV1J7AZetEsE/) |
| 2025-05-27 | 康波周期论：你不能不知道的经济学常识 | 65,868 | 2,079 | 2,224 | [BV19JjZzkEU7](https://www.bilibili.com/video/BV19JjZzkEU7/) |
| 2025-07-09 | 30万存款魔咒和消费主义陷阱是罪魁祸首！ | 61,076 | 1,163 | 927 | [BV1vNGPzUEb6](https://www.bilibili.com/video/BV1vNGPzUEb6/) |
| 2025-07-22 | 掌握一个财富公式和三项核心技能，2年至少100万！ | 158,844 | 5,586 | 9,159 | [BV1WNgpzyEru](https://www.bilibili.com/video/BV1WNgpzyEru/) |
| 2025-08-26 | 想赚钱？请以最快的速度，把你的内容产品化！ | 28,063 | 786 | 1,145 | [BV1iieoz9E41](https://www.bilibili.com/video/BV1iieoz9E41/) |
| 2026-02-05 | 震惊！原来钱要这么挣？！ | 46,408 | 1,213 | 2,099 | [BV1btFazWEfE](https://www.bilibili.com/video/BV1btFazWEfE/) |
| 2026-04-02 | 淘汰你，与你何干？ | 23,578 | 769 | 756 | [BV1JqXZBZEFe](https://www.bilibili.com/video/BV1JqXZBZEFe/) |
| 2026-06-15 | 你的收入来源有几种？ | 45,627 | 478 | 508 | [BV1P6JM62EK4](https://www.bilibili.com/video/BV1P6JM62EK4/) |

这24集累计播放计数之和为 2,587,807，中位数 61,237.5，最低 23,578，最高 435,418。累计播放之和不能当独立观众数。合集发布日期跨度较长，不能把播放高低直接解释为内容类型优劣或作者能力变化。

## 补充8条：逐条view返回的当前标题

| 日期 | 单条页标题 | 播放快照 | 时长 | 原视频 |
| --- | --- | ---: | --- | --- |
| 2024-08-18 | 哪种副业真能挣到钱？9种副业真实测试，第5项结果令人意外！ | 2,819,076 | 31:23 | [BV1LhWAeXEth](https://www.bilibili.com/video/BV1LhWAeXEth/) |
| 2024-09-07 | 如何成功打造自媒体账号？超详细分析教程。 | 524,383 | 44:18 | [BV1piHdeGEXv](https://www.bilibili.com/video/BV1piHdeGEXv/) |
| 2024-09-19 | 尘封8年的项目，被我复活啦！睡后收入从此源源而来。 | 313,142 | 11:04 | [BV1tjtpeBEpS](https://www.bilibili.com/video/BV1tjtpeBEpS/) |
| 2024-10-11 | 送你一套Notion效率模板，开启人生作弊器，从此开挂！ | 60,553 | 17:34 | [BV19B2mYLETp](https://www.bilibili.com/video/BV19B2mYLETp/) |
| 2024-10-18 | 闲鱼货源怎么找？远在天边，近在眼前。 | 240,148 | 19:47 | [BV18vC1YfE8o](https://www.bilibili.com/video/BV18vC1YfE8o/) |
| 2026-06-26 | 我养了一支AI电商团队，爽爆了！ | 61,031 | 7:30 | [BV1CNj26VE7e](https://www.bilibili.com/video/BV1CNj26VE7e/) |
| 2025-02-10 | 超简单的网盘拉新，真金白银，睡后收入又多了一项 | 82,122 | 6:30 | [BV1UYN3emE7W](https://www.bilibili.com/video/BV1UYN3emE7W/) |
| 2025-01-25 | 自媒体起号是有方法的，整整9页A4纸，不能更详细了。 | 73,383 | 22:02 | [BV1zHfdYGEyD](https://www.bilibili.com/video/BV1zHfdYGEyD/) |

## 可以由此支持的判断

1. 该账号的“副业测试”确有明显的高播放单条：281.9万级；同时，2024年9月的自媒体教程约52.4万、旧项目与睡后收入约31.3万。不能称这些视频全是抽象财富观点。
2. 工具直接赠送的Notion条目约6.1万，与同一作者的副业测试、旧项目收益题目存在明显累计播放差异。这是同账号的描述性对比；发布日期、标题、封面、曝光、粉丝基数、受众和内容质量都未控制，不能归因成“赚钱标题导致提升多少倍”。
3. “普通人如何达到收入”“如何选择”“测试结果/意外”“方法与步骤”等观众导向题目在高播放样本里出现；这支持分析内容承诺，不支持测出观众动机占比。
4. 2026年的AI电商团队条目约6.1万，2025年的内容产品化条目约2.8万；仅有AI或赚钱措辞不能保证百万播放。
5. 核心合集有多条低于10万，因而“该账号每条早期内容都很多播放”应限定到具体样本与基准，不能把爆款代表全部。

## 内容观看的限制

补充8条的公开view响应均为desc空字符串、subtitle.list空列表；本文件没有取得逐字稿，也没有声称完整看完或复核了口播内容。有关旧项目怎么改、收入是多少、测试过程如何展开，应由主研究额外媒体/原文证据支持，不能只凭标题补齐。粉丝笔记可作线索，但不能替代作者原视频及账单。

本轮只新增研究资料，没有联系他人、发布内容、改动应用代码或运行模型/业务测试。
