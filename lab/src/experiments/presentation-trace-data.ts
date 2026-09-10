export interface PresentationTraceCall {
  id: string
  name: string
  status: 'success' | 'error'
  arguments: Record<string, unknown>
  result: unknown
  error?: string
}

export interface PresentationTracePromptBlock {
  id: string
  label: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  fidelity: 'illustrative' | 'recorded'
  content: string
}

export interface PresentationTraceRound {
  id: string
  stage: 'main' | 'ppt_brief' | 'ppt_plan'
  title: string
  summary: string
  decision: string
  evidence: string[]
  calls: PresentationTraceCall[]
  promptBlocks: PresentationTracePromptBlock[]
}

export interface PresentationTraceSlide {
  id: string
  title: string
  purpose: string
  keyMessage: string
  bullets: string[]
  sourceIds: string[]
}

export interface PresentationTraceChapter {
  id: string
  title: string
  slides: PresentationTraceSlide[]
}

export interface PresentationTraceSource {
  id: string
  title: string
  kind: 'brief' | 'web'
  status: 'available' | 'unverified'
  note: string
}

export interface PresentationTrace {
  title: string
  input: string
  brief: string
  chapters: PresentationTraceChapter[]
  sources: PresentationTraceSource[]
  rounds: PresentationTraceRound[]
  reportedSlideCount: number
}

/** Sanitized, simulated trace for interaction design; never a database response. */
export function getPresentationTrace(locale: 'zh-CN' | 'en-US'): PresentationTrace {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const input = t('帮我做一个讲解佛教的 PPT', 'Help me create a presentation explaining Buddhism.')
  const brief = t('受众：中学生，零基础。\n使用方式：自主阅读，每页需能独立理解。\n目标：认识佛教的历史背景、基本概念和文化影响。\n结构：起源 → 核心观念 → 传播 → 文化与回顾。\n表达：中性、通俗，区分历史描述与宗教信仰。\n资料要求：标明来源；未经核验的内容不得作为已证实事实交付。', 'Audience: secondary school students with no prior knowledge.\nFormat: self-paced reading; each slide should stand on its own.\nGoal: understand Buddhism’s historical context, basic concepts, and cultural influence.\nStructure: origins → core ideas → spread → culture and recap.\nStyle: neutral and accessible; distinguish historical description from religious belief.\nSources: cite references and flag claims that still require verification.')
  const slide = (id: string, title: string, purpose: string, keyMessage: string, bullets: string[], sourceIds = ['source-brief', 'source-history']): PresentationTraceSlide => ({ id, title, purpose, keyMessage, bullets, sourceIds })
  const chapters: PresentationTraceChapter[] = [
    { id: 'chapter-1', title: t('从问题出发：认识佛教', 'Start with questions: an introduction'), slides: [
      slide('slide-01', t('佛教：一段思想与文化之旅', 'Buddhism: a journey through ideas and culture'), t('封面与阅读目标', 'Introduce the topic and reading goals'), t('从历史、观念和文化三个角度认识佛教。', 'Explore Buddhism through history, ideas, and culture.'), [t('适合零基础读者', 'Designed for readers with no prior knowledge'), t('带着“起源、观念、影响”三个问题阅读', 'Read with three questions: origins, ideas, and influence')], ['source-brief']),
      slide('slide-02', t('这份材料怎样阅读', 'How to read this presentation'), t('建立阅读路径', 'Establish a reading path'), t('先理解背景，再认识概念，最后回看文化影响。', 'Understand the context, explore the concepts, then consider cultural influence.'), [t('不预设宗教知识', 'No religious knowledge is assumed'), t('关键概念配合生活情境解释', 'Key concepts are introduced through familiar situations')], ['source-brief']),
      slide('slide-03', t('佛教兴起的历史背景', 'The historical setting'), t('交代时代与地域', 'Establish the historical and geographic context'), t('把思想放回当时的社会环境中理解。', 'Understand the ideas within their social context.'), [t('以古代南亚为地理起点', 'Begin geographically in ancient South Asia'), t('具体年代与表述仍需资料核验', 'Dates and historical wording still require verification')]),
    ] },
    { id: 'chapter-2', title: t('理解核心观念', 'Understand the core ideas'), slides: [
      slide('slide-04', t('从悉达多到佛陀', 'From Siddhartha to the Buddha'), t('介绍人物与传统叙述', 'Introduce the figure and traditional narratives'), t('区分历史人物、宗教传统与后世叙述。', 'Distinguish the historical figure, religious tradition, and later narratives.'), [t('用简洁时间线组织人物经历', 'Use a concise timeline to organize the account'), t('传统故事明确标注叙述性质', 'Label traditional stories as such')]),
      slide('slide-05', t('“苦”在讨论什么', 'What does dukkha address?'), t('解释一个基础概念', 'Explain a foundational concept'), t('通过日常变化和期待落差引入概念，避免简单化。', 'Introduce the concept through change and unmet expectations without oversimplifying it.'), [t('先给出生活情境，再解释术语', 'Start with a familiar situation before introducing the term'), t('概念译法和解释有待权威来源核对', 'Check translations and explanations against authoritative sources')], ['source-brief', 'source-concepts']),
      slide('slide-06', t('修行与日常行为', 'Practice and everyday conduct'), t('串联观念与行为', 'Connect ideas with behavior'), t('说明传统如何理解行为、注意力与心态之间的关系。', 'Describe how the tradition relates conduct, attention, and mental habits.'), [t('使用观察行为的例子', 'Use examples of observing behavior'), t('不把教学说明写成实践劝导', 'Keep explanation separate from advocacy')], ['source-brief', 'source-concepts']),
    ] },
    { id: 'chapter-3', title: t('传播与多样性', 'Spread and diversity'), slides: [
      slide('slide-07', t('佛教如何传播', 'How Buddhism spread'), t('建立空间与时间联系', 'Connect geography and chronology'), t('传播伴随着交流、翻译与地方文化互动。', 'The spread involved exchange, translation, and interaction with local cultures.'), [t('用路线图展示传播方向', 'Show directions of spread on a route map'), t('路线与年代在制作前完成核验', 'Verify routes and dates before composition')]),
      slide('slide-08', t('不同地区的佛教传统', 'Traditions across regions'), t('呈现内部多样性', 'Present diversity within Buddhism'), t('“佛教”包含不同的历史发展与实践传统。', 'Buddhism includes diverse historical developments and traditions of practice.'), [t('以比较表辅助阅读', 'Use a comparison table to support reading'), t('避免将所有地区概括成同一种面貌', 'Avoid treating all regions as uniform')], ['source-brief', 'source-concepts']),
    ] },
    { id: 'chapter-4', title: t('文化影响与回顾', 'Cultural influence and recap'), slides: [
      slide('slide-09', t('艺术中的佛教元素', 'Buddhist elements in art'), t('从具体作品观察影响', 'Observe influence through specific works'), t('通过建筑、雕塑与绘画认识文化表达。', 'Explore cultural expression through architecture, sculpture, and painting.'), [t('为每件示例作品标明出处', 'Credit each example artwork'), t('图片授权与作品信息仍待核验', 'Verify image rights and artwork information')], ['source-brief', 'source-art']),
      slide('slide-10', t('三个问题，回顾所学', 'Three questions to review'), t('帮助自主阅读者回顾', 'Help independent readers review'), t('能用自己的话说明起源、核心观念和文化影响。', 'Explain the origins, core ideas, and cultural influence in your own words.'), [t('它在怎样的背景中出现？', 'In what context did it emerge?'), t('哪些概念需要进一步查证？', 'Which concepts need further checking?'), t('文化影响可以从哪里观察？', 'Where can its cultural influence be observed?')], ['source-brief']),
      slide('slide-11', t('参考资料与待核验项', 'References and items to verify'), t('呈现来源与局限', 'Show sources and limitations'), t('当前资料获取失败，参考线索不能等同于已核验依据。', 'Source retrieval failed; reference leads are not verified evidence.'), [t('列出需求简报与参考线索', 'List the brief and reference leads'), t('制作与交付前补齐来源核验', 'Complete source verification before composition and delivery')], ['source-brief', 'source-history', 'source-concepts', 'source-art']),
    ] },
  ]
  const sources: PresentationTraceSource[] = [
    { id: 'source-brief', title: 'brief.md', kind: 'brief', status: 'available', note: t('R03 写入，R04 读取；记录受众、阅读方式与表达约束。', 'Written in R03 and read in R04; contains the audience, reading format, and tone constraints.') },
    { id: 'source-history', title: t('佛教历史与起源 · 参考线索', 'Buddhist history and origins · reference lead'), kind: 'web', status: 'unverified', note: t('计划参考 Britannica 与 asia.si.edu；抓取失败，未获得可核验正文。', 'Britannica and asia.si.edu were proposed as references; fetches failed and no verifiable text was retrieved.') },
    { id: 'source-concepts', title: t('佛教观念与地区传统 · 参考线索', 'Buddhist ideas and regional traditions · reference lead'), kind: 'web', status: 'unverified', note: t('计划参考 IEP 与 Pew Research；抓取失败，暂不能支持具体论断。', 'IEP and Pew Research were proposed as references; failed fetches cannot support specific claims.') },
    { id: 'source-art', title: t('佛教艺术 · 参考线索', 'Buddhist art · reference lead'), kind: 'web', status: 'unverified', note: t('计划参考 The Met；抓取返回 429，作品与图片信息仍待核验。', 'The Met was proposed as a reference; the fetch returned 429, so artwork and image information remains unverified.') },
  ]
  const call = (id: string, name: string, args: Record<string, unknown>, result: unknown): PresentationTraceCall => ({ id, name, status: 'success', arguments: args, result })
  const fetchFailure = (id: string, domain: string, status: number): PresentationTraceCall => ({ id, name: 'web_fetch', status: 'error', arguments: { url: `https://${domain}/` }, result: { status_code: status, content: null }, error: `HTTP ${status}` })
  const round = (id: string, stage: PresentationTraceRound['stage'], title: string, summary: string, decision: string, evidence: string[], calls: PresentationTraceCall[]): PresentationTraceRound => ({
    id, stage, title, summary, decision, evidence, calls, promptBlocks: [],
  })
  const rounds: PresentationTraceRound[] = [
    round('R01', 'main', t('进入 PPT 编排', 'Enter presentation orchestration'), t('识别到佛教入门 PPT 制作需求，调用演示工作流入口。', 'Recognize an introductory Buddhism presentation request and invoke the presentation workflow.'), t('交接至明确需求阶段。', 'Hand off to the briefing stage.'), [t('初始任务已收到，受众与阅读方式仍需确认。', 'Initial task received; confirm the audience and reading format.')], [call('call-01', 'request_presentation', { goal: input }, { next_stage: 'ppt_brief' })]),
    round('R02', 'ppt_brief', t('确认受众与阅读方式', 'Confirm audience and reading format'), t('确认面向中学生，材料用于自主阅读。', 'Confirm a secondary school audience and self-paced reading.'), t('关键需求明确，开始整理 brief。', 'Core requirements are clear; prepare the brief.'), [t('受众：中学生；用途：自主阅读；表达：通俗、中性。', 'Audience: secondary school students; format: self-paced; tone: accessible and neutral.')], [call('call-02', 'request_human_choice', { prompt: t('正在整理制作需求，需要确认受众与使用方式，以确定内容深度和每页的信息量。', 'Confirm the audience and reading format to determine the depth and amount of information per slide.'), questions: JSON.stringify({ questions: [{ header: t('受众', 'Audience'), question: t('这份 PPT 面向谁？', 'Who is this presentation for?'), options: [{ label: t('中学生', 'Secondary school students') }, { label: t('成年人', 'Adults') }] }, { header: t('使用方式', 'Format'), question: t('这份 PPT 怎样使用？', 'How will this presentation be used?'), options: [{ label: t('自主阅读', 'Self-paced reading') }, { label: t('课堂讲解', 'Classroom presentation') }] }] }) }, { audience: t('中学生', 'Secondary school students'), reading_mode: 'self_paced', confirmed: true })]),
    round('R03', 'ppt_brief', t('写入需求简报', 'Write the brief'), t('将确认后的目标、约束和阅读结构写入 brief.md。', 'Write the confirmed goals, constraints, and reading structure to brief.md.'), t('简报已形成，下一轮检查交接内容。', 'The brief is ready; check its handoff content next.'), [t('确认结果作为写入依据，未添加未经确认的时长或页数要求。', 'Use the confirmed requirements without inventing duration or slide-count constraints.')], [call('call-03', 'write_file', { file_path: '.presentation/brief.md', content: brief }, { file_path: '.presentation/brief.md', written: true })]),
    round('R04', 'ppt_brief', t('核对需求简报', 'Check the brief'), t('重新读取 brief.md，检查是否覆盖受众与自主阅读要求。', 'Read brief.md and check that it covers the audience and independent-reading requirements.'), t('简报可交接至规划阶段。', 'The brief is ready for planning.'), [t('brief.md 已存在，核心需求有明确记录。', 'brief.md exists and explicitly records the core requirements.')], [call('call-04', 'read_file', { file_path: '.presentation/brief.md' }, { content: brief })]),
    round('R05', 'ppt_brief', t('交接页面规划', 'Hand off to slide planning'), t('需求阶段完成，切换到 ppt_plan。', 'Complete the briefing stage and switch to ppt_plan.'), t('进入资料准备与大纲规划。', 'Begin source preparation and outline planning.'), [t('后续规划以 brief.md 为输入。', 'The planning stage uses brief.md as its input.')], [call('call-05', 'switch', { stage: 'ppt_plan', reason: t('需求已确认并写入 .presentation/brief.md，开始规划页面。', 'Requirements are confirmed and saved in .presentation/brief.md; begin planning the slides.') }, { previous_stage: 'ppt_brief', next_stage: 'ppt_plan' })]),
    round('R06', 'ppt_plan', t('搜索资料：4 次失败', 'Source search: four failures'), t('尝试检索历史、观念、传播与艺术资料，未获得搜索结果。', 'Try searches on history, ideas, spread, and art; no search results are retrieved.'), t('搜索未成功，改为尝试直接抓取参考网站。', 'Searches failed; try fetching reference sites directly.'), [t('4 次 web_search 均失败；返回记录未包含具体错误原因。', 'All four web_search calls failed; the results contain no specific error reason.')], [
      t('佛教 起源 历史 入门', 'Buddhism origins history introduction'), t('佛教 核心观念 权威资料', 'Buddhism core ideas authoritative sources'), t('佛教 传播 地区传统', 'Buddhism spread regional traditions'), t('佛教 艺术 博物馆', 'Buddhist art museum'),
    ].map((query, index) => ({ id: `call-0${index + 6}`, name: 'web_search', status: 'error', arguments: { query }, result: { success: false, results: [] }, error: t('未记录具体错误原因', 'Specific error reason not recorded') }))),
    round('R07', 'ppt_plan', t('直接抓取：首批 3 次失败', 'Direct fetch: first three failures'), t('直接访问三处参考网站，均未获取正文。', 'Visit three reference sites directly; no article text is retrieved.'), t('继续尝试其他来源，当前资料仍未核验。', 'Try other sources; current reference leads remain unverified.'), [t('HTTP 状态为 403、403、404，没有可使用的正文内容。', 'HTTP statuses: 403, 403, and 404; no usable article content.')], [fetchFailure('call-10', 'www.britannica.com', 403), fetchFailure('call-11', 'asia.si.edu', 403), fetchFailure('call-12', 'www.pewresearch.org', 404)]),
    round('R08', 'ppt_plan', t('继续抓取：另外 3 次失败', 'Further fetches: three more failures'), t('补充访问哲学百科与博物馆等来源，仍未获取正文。', 'Try an encyclopedia and museum among other sources; no article text is retrieved.'), t('保留参考线索，明确标记资料缺口。', 'Keep the reference leads and explicitly flag the evidence gap.'), [t('HTTP 状态为 404、429、404；累计 10 次资料获取均失败。', 'HTTP statuses: 404, 429, and 404; all ten retrieval attempts have failed.')], [fetchFailure('call-13', 'iep.utm.edu', 404), fetchFailure('call-14', 'www.metmuseum.org', 429), fetchFailure('call-15', 'www.pewresearch.org', 404)]),
    round('R09', 'ppt_plan', t('提交资料整理报告', 'Submit the source-preparation report'), t('记录参考线索与访问失败情况，保留待核验标记。', 'Record reference leads and access failures while retaining the unverified status.'), t('报告被接收，继续形成供讨论的大纲；资料尚未得到验证。', 'The report is accepted; proceed to a discussion outline while sources remain unverified.'), [t('收集到的是参考线索，不是成功抓取的证据正文。', 'The collected items are reference leads, not successfully retrieved evidence.')], [call('call-16', 'report_presentation_step', { summary: t('资料获取失败，整理参考线索并保留待核验标记。', 'Retrieval failed; organize reference leads and retain the unverified status.'), evidence: [t('4 次搜索、6 次抓取均未获得可使用的正文。', 'Four searches and six fetches retrieved no usable source text.')], data: JSON.stringify({ sources: sources.filter(source => source.kind === 'web') }) }, { accepted: true, next_step: 'map_slides', verified_web_sources: 0 })]),
    round('R10', 'ppt_plan', t('提交大纲，等待确认', 'Submit the outline and await confirmation'), t('报告摘要称已规划 12 页；实际提交的大纲包含 4 章、11 页。', 'The report summary claims twelve slides; the submitted outline actually contains four chapters and eleven slides.'), t('等待用户确认大纲；尚未进入制作与检查阶段。', 'Wait for outline confirmation; composition and review have not started.'), [t('结构化大纲：3 + 3 + 2 + 3 = 11 页。', 'Structured outline: 3 + 3 + 2 + 3 = 11 slides.'), t('工具返回 awaiting_outline_confirmation，继续执行需要用户确认。', 'The tool returned awaiting_outline_confirmation; continuing requires user confirmation.'), t('资料线索仍待核验，报告页数与产物页数不一致。', 'Reference leads remain unverified, and the reported slide count differs from the artifact.')], [call('call-17', 'report_presentation_step', { summary: t('已形成 12 页大纲。', 'A twelve-slide outline has been prepared.'), evidence: ['.presentation/brief.md', t('网页来源仍待核验。', 'Web sources still require verification.')], data: JSON.stringify({ chapters: chapters.map(chapter => ({ title: chapter.title, slides: chapter.slides.map(({ id, title }) => ({ id, title })) })) }) }, { accepted: true, status: 'awaiting_outline_confirmation', chapter_count: 4, slide_count: 11 })]),
  ]
  rounds.forEach((current, index) => {
    const prior = rounds[index - 1]
    current.promptBlocks = [
      { id: `${current.id}-stage`, label: t('阶段指令 · 示意', 'Stage instruction · illustrative'), role: 'system', fidelity: 'illustrative', content: current.stage === 'main' ? t('识别任务类型，将演示文稿需求交给 PPT 编排流程。', 'Identify the task type and route presentation requests to presentation orchestration.') : current.stage === 'ppt_brief' ? t('确认受众、阅读方式与表达约束；形成可交接的需求简报。', 'Confirm the audience, reading format, and tone constraints; produce a brief for handoff.') : t('依据需求简报组织逐页大纲；明确资料局限，提交大纲后等待用户确认。', 'Use the brief to organize a slide outline; identify source limitations and wait for user confirmation after submitting it.') },
      { id: `${current.id}-task`, label: t('初始任务 · 示意', 'Initial task · illustrative'), role: 'user', fidelity: 'illustrative', content: input },
    ]
    if (prior) current.promptBlocks.push(
      { id: `${current.id}-history`, label: t(`${prior.id} 响应摘要 · 示意`, `${prior.id} response summary · illustrative`), role: 'assistant', fidelity: 'illustrative', content: prior.summary.slice(0, 1000) },
      { id: `${current.id}-results`, label: t(`${prior.id} 工具结果 · 示意`, `${prior.id} tool results · illustrative`), role: 'tool', fidelity: 'illustrative', content: JSON.stringify(prior.calls.map(({ name, status, result, error }) => ({ name, status, result, ...(error ? { error } : {}) })), null, 2).slice(0, 1000) },
    )
  })
  return { title: t('制作佛教讲解 PPT', 'Create an introductory Buddhism presentation'), input, brief, chapters, sources, rounds, reportedSlideCount: 12 }
}
