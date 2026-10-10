# 更新日志

本单仓三个插件的改动记录。每个插件自己的 README 里还有对应的「版本」小节（含背景与权衡），
这里只列**改了什么、为什么改、被什么测试盯住了**。

本轮（2026-10-10）是一次**缺陷检修**：没有新增功能，修的都是「看起来有结果、其实答错了」的问题。
三个插件各自的测试全部通过，且每个缺陷都补了回归断言：

| 插件 | 版本 | 测试 |
| --- | --- | --- |
| dsh-ct-norm | 0.1.0 → **0.1.1** | `node test-ct-norm.mjs` → 199 项 |
| dsh-onco-lexicon | 0.7.0 → **0.7.1** | `node test-onco-lexicon.mjs` / `test-panel.mjs` / `test-client.mjs` / `test-translate-integration.mjs` → 64 / 165 / 337 / 125 项 |
| dsh-lit-translate | 0.2.0 → **0.2.1** | `node test-mesh.mjs` / `test-lit-translate.mjs` → 81 / 148 项 |

---

## dsh-ct-norm 0.1.1 —— 六类抽取缺陷

数据层的概念没有增删（仍是 327 条写法 / 2190 个表面写法 / 370 条 MeSH 概念）。

1. **单位 `mm` 被归一到 Multiple Myeloma（最严重）**。词表里 `multiple-myeloma` 的英文别名含
   `mm`，而匹配层对拉丁别名**没有任何词边界**：`5mm`、`５ｍｍ`、`3 MM`、`mmol/L` 全都会命中，
   于是报告里每一处径线都变成一条「多发性骨髓瘤」。现在拉丁别名必须过词边界，
   且长度 ≤3 的纯字母缩写隔着空格紧跟在数字后面时按单位处理。
   `MM 患者` 这类真实写法照常命中。
2. **否定整小句生效 → 极性反转**。「肝内见转移灶、未见腹水」里的「转移灶」被标成否定
   （「、」不切小句，本意是让「未见胸腔积液、腹水」里的「腹水」保住否定）。极性与数量改为
   **按提及位置**判定：提示词必须落在该提及结束位置之前才作用于它，两类写法同时正确。
3. **不确定无条件压过否定**。「未见胸腔积液考虑胸膜粘连」丢掉了明确写出的「未见」。
   改为按提示词位置取舍，同时保留「不除外」优先于其中的「除外」。
4. **尺寸取窗口里第一个数字**。「右肺上叶结节2.3cm、左肺下叶结节1.5cm」两个结节都报 2.3cm。
   改为取离该提及最近的数值（同距离优先取后者）。
5. **数量词被屏蔽却抽不回来，并把单发错编成多发**。`一枚 / 两枚 / 成团 / 簇状` 在
   `filler.count` 里却不在 `attributes.count.cues` 里，于是报告写了数量仍报「没写单发还是多发」；
   且数量曾整小句共用，「双肺多发结节、右肺上叶单发结节」会把后者编成
   Multiple Pulmonary Nodules（**错的 MeSH 描述符**）。
6. **组合不出概念时丢掉已绑定的部位**。「胸壁占位」里「胸壁」在整份输出中消失
   （`siteMentions=1` 而 `orphanSites=0`，自相矛盾），理由还写成「同一句内没有可供绑定的部位」。
   另外「转移至肝」的部位优先级提到同句兜底之前（旧顺序会绑到同句更远的「右肺」，
   再按规则给出 Lung Neoplasms），未归一化理由里的 `bowel wall thickening` 改为涵盖全部别名，
   并去掉 reason 里手写的 MeSH 编号。

改动文件：`lib/lexicon.js`、`lib/normalize.js`、`lib/text.js`、`data/ct.rules.json`
（+ 重建 `data/ct.lexicon.jsonl` / `mesh.subset.jsonl` / `ct.manifest.json`，前两者内容未变）。
回归断言见 `test-ct-norm.mjs` 第 15 节。

## dsh-onco-lexicon 0.7.1 —— 噪声命中、假总数与缓存串号

1. **联网缓存按有损键取值，返回了别的查询的结果**。缓存键用过 `normKey`（把非字母数字
   一律抹成空格），所有纯中文查询因此塌成同一个空键：查过「高血压」再查「糖尿病」，
   会拿到「高血压」那段兜底结果（连 `query` 都回显着上一个词）；`ER+` 与 `ER` 同样撞键。
   现在缓存键用实际查询文本，只做大小写与空白归一。
2. **中文查询靠一个汉字就算命中**。「磨玻璃结节」曾以 13% 覆盖率、51.9 分越过阈值，把
   「结直肠癌」「前哨淋巴结」当成结果返回，真正的「未收录」提示与联网兜底被噪声挡住。
   现在查询里有 ≥2 个汉字时，命中的汉字 token 至少要 2 个字才算数。
3. **`onco_abbr` 谎报义项数，并把别的缩写当义项**。结果被切到 10 条后头部写「共有 10 个义项」，
   而 `PR` 的真实义项有 21 个；`MM` 的列表里混着 MMP-2 / MM-151（那是**别的缩写**）。
   现在分「义项」与「同前缀的其它缩写」两栏，头部报真实总数，并新增 `topK`（默认 20，上限 50）。
4. **筛查条件被绕过**。`onco_term` 带 `category` / `source` / `ncitType` 时，联网段曾挂着
   「已按…筛查」的横幅，而联网结果根本没有这些字段；面板 RPC 在「本地有命中、只是被筛查条件
   排除」时也会联网。两处现在都如实标注 / 不联网。
5. **`onco_translate` 把英文功能词当术语**。`The patient received osimertinib; … was 50%`
   曾被标成 6 个术语、覆盖率 79.7%，其中 `was` → WAS 基因、`50` → Fifty、`received` → Receive。
   现在英译中方向先摘掉功能词与纯数字；`MET` / `ATM` 这类与基因同形的实词**不**屏蔽。
6. **Windows 绝对路径 `dictPath` 让插件完全不可用**。`C:\…` 不是「以 `/` 开头」，被交给
   `new URL` 后 `c:` 被当成协议名，`fileURLToPath` 抛错，四个工具全部回答「词典不可用」。
   改用 `path.isAbsolute` + `pathToFileURL`。
7. `onco_browse` 空结果不再一律归咎于类别：关键词 / 类型 / 出处筛空时分别说明是哪个条件筛空的。

改动文件：`lib/index.js`、`lib/online.js`、`package.json`、`README.md`。
回归断言见 `test-onco-lexicon.mjs` 第 11 节与 `test-panel.mjs` 第 11 节。

## dsh-lit-translate 0.2.1 —— 术语噪声、损坏索引与面板配置

1. **单字命中的错配概念**：`adjustment` → Adaptation, Psychological（D000223）、
   `association` → Association（D001244）、`compliance` → Compliance（D003187）这类
   「普通英文词撞上 MeSH 入口词」的约束，会把统计学的「校正 / 关联 / 依从」推向心理学概念。
   现在单字命中必须**就是该 MeSH 记录的规范名**、且不落在 `concept` 抽象桶里；
   全大写缩写不受限，多词短语照旧（代价是 `statin` 这类纯同义词映射不再注入——这条通道的价值在于准）。
2. **逗号不是边界，n-gram 拼出假短语**：`age, sex, education, income` 里的「sex, education」
   曾命中 Sex Education（D012736），提示词里出现原文根本没有的术语。逗号已纳入片段边界。
3. **出版物特征被当成术语**：`Overall`（D016424，一种出版物类型）曾被注入提示词。
   树号 `V*` 的单字命中一律不接受。
4. **头部合法但正文被截断的 MeSH 索引会让翻译整个失败**：`ping` 报「355,232 条」看起来健康，
   真去翻译却抛 RangeError（工具直接抛栈、面板只显示一句 Node 报错）。现在构造函数与
   `status()` 都会核对偏移表是否落在文件内：索引不可用时如实报出，翻译按文档承诺照常进行。
5. **面板无视宿主配置**：`ping` 回传的 `maxChars` / `annotate` / `mesh.enabled` 之前没被使用——
   配置 `maxChars: 1000` 时面板仍按 1400 切段，每一段都被宿主以「超过单次上限」拒掉，
   批量翻译在第一段就中断，面板一个字都翻不了。现在切段按宿主上限、两个开关的初值取配置，
   并按 `meshDisabled` 显示「MeSH 未启用」（与「0 命中」区分开）。
6. **`annotate: false` 与术语块措辞冲突**：纯中文模式的系统提示词写着「专业术语不要附英文原文」，
   术语块却仍要求「上述英文术语按 MeSH 规范名书写」。现在措辞随 `annotate` 切换。
7. 顺带修掉：人话提示（余额 / 限流）在工具失败信息里出现两遍；面板 500 的原始报错改为
   「插件内部错误（已记录到 DSH 日志）」并把原始信息写进日志；`finish` 只给了
   `aborted` / `error` 而没带 `failure` 时也按失败处理（半截译文不再被当成完整结果返回）。

改动文件：`lib/mesh.js`、`lib/index.js`、`lib/client.js`、`package.json`、`README.md`。
回归断言见 `test-mesh.mjs` 第 6/7 节与 `test-lit-translate.mjs` 的切段断言。

---

## 更早

* **dsh-ct-norm 0.1.0** —— 首版：`ct_norm` / `ct_lexicon` + 侧边栏面板 + 词表与 MeSH 概念子集。
* **dsh-onco-lexicon 0.7.0** —— 联网兜底（本地优先）：本地零命中时才查 NCIt / MeSH，
  结果单独标注，面板与导出同步支持。
* **dsh-onco-lexicon 0.6.1** —— 许可与署名落地（LICENSE / THIRD-PARTY-NOTICES / 包元数据）。
* **dsh-lit-translate 0.2.0** —— 加入 MeSH 2026 离线术语层（`lib/mesh.js` + `mesh_index.bin`）。
* **dsh-lit-translate 0.1.x** —— 从 `dsh-literature-reading` v1.19.0 拆出「学术英译中」独立成插件。
