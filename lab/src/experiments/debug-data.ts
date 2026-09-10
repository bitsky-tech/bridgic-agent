import { getDemoScenarios, type ScenarioId } from './demo-data'

export interface DebugPromptBlock {
  id: string
  label: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  source: string
  content: string
}

export interface DebugTool {
  name: string
  description: string
  source: string
  availability: 'available' | 'unavailable'
  reason: string
  schema: Record<string, unknown>
}

export interface DebugStage {
  mode: string
  worker: string
  cognitiveSource: string
  promptSource: string
  purpose: string
  entry: string[]
  exit: string[]
  nextStage: string
  blocks: DebugPromptBlock[]
  tools: DebugTool[]
  before: Record<string, unknown>
  after: Record<string, unknown>
  decision: string
  response: string
  call: {
    tool: string
    arguments: Record<string, unknown>
    result: Record<string, unknown>
  }
}

type Locale = 'zh-CN' | 'en-US'
type Text = (zh: string, en: string) => string

interface StageExample {
  worker: string
  module: string
  persona: string
  entry: string[]
  exit: string[]
  next: string
  context: string
  history: string
  feedback: string
  available: string[]
  unavailable: string
  unavailableReason: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  decision: string
  response: string
  call: DebugStage['call']
}

const ROOT = 'src/amphi_agent'
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required,
})
const string = { type: 'string' }
const strings = { type: 'array', items: string }

/** A documented subset, not a dump of a running worker's complete tool surface. */
function toolCatalog(t: Text): Record<string, Omit<DebugTool, 'availability' | 'reason'>> {
  const tool = (name: string, file: string, description: string, parameters: Record<string, unknown>) => ({
    name, source: `${ROOT}/tools/${file}.py`, description, schema: parameters,
  })
  return {
    read_file: tool('read_file', '_filesystem', t('读取工作区文件，恢复资料或上游产物。', 'Read workspace files, source material, or upstream artifacts.'), schema({ file_path: string, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['file_path'])),
    write_file: tool('write_file', '_filesystem', t('创建或完整写入一个文件。', 'Create or completely overwrite a file.'), schema({ file_path: string, content: string }, ['file_path', 'content'])),
    edit_file: tool('edit_file', '_filesystem', t('在已读取的文件中做精确文本替换。', 'Replace exact text in a previously read file.'), schema({ file_path: string, old_string: string, new_string: string, replace_all: { type: 'boolean' } }, ['file_path', 'old_string', 'new_string'])),
    grep: tool('grep', '_filesystem', t('检索文件中的证据和关键字段。', 'Find evidence and fields in files.'), schema({ pattern: string, path: string, glob: string }, ['pattern'])),
    bash: tool('bash', '_bash', t('在指定目录运行命令；此原型不会执行。', 'Run a command in a specified directory; this prototype never executes it.'), schema({ command: string, cwd: string, timeout: { type: 'integer' } }, ['command', 'cwd'])),
    web_search: tool('web_search', '_web_search', t('检索公开资料的链接与摘要。', 'Search public sources for links and summaries.'), schema({ query: string, search_engine: { type: 'string', enum: ['duckduckgo', 'bing', 'baidu'] }, num_results: { type: 'integer' } }, ['query'])),
    request_human_choice: tool('request_human_choice', '_request_human', t('对会改变方案的缺失信息请求用户选择。', 'Ask the user to resolve missing information that changes the plan.'), schema({ questions: string, prompt: string }, ['questions', 'prompt'])),
    request_human_task_confirm: tool('request_human_task_confirm', 'build/request_human', t('提交 task.md 给用户确认，并暂停当前轮。', 'Submit task.md for user confirmation and pause the current turn.'), schema({})),
    request_human_workflow_confirm: tool('request_human_workflow_confirm', 'build/request_human', t('提交已验证工作流的命名与确认卡片。', 'Request a name and confirmation for a verified workflow.'), schema({ prompt: { type: 'string', description: t('JSON 字符串，包含 default_name 和可选 summary。', 'A JSON string with default_name and optional summary.') } }, ['prompt'])),
    report_presentation_step: tool('report_presentation_step', 'ppt/progress', t('上报当前 PPT 制作步骤，由运行时校验并推进。', 'Report the current presentation step for runtime validation and advancement.'), schema({ summary: string, evidence: strings, data: { type: 'string', description: t('步骤结果的 JSON 对象字符串。', 'A JSON-encoded object containing the step result.') } }, ['summary'])),
    ppt_rag: tool('ppt_rag', 'ppt/ppt_rag', t('在大纲确认后的视觉设计步骤检索模板。', 'Retrieve templates during visual design after outline confirmation.'), schema({ preferences: { type: 'string', maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 8 } })),
    report_workflow_step: tool('report_workflow_step', 'workflow/progress', t('记录当前执行章节的结果，成功后推进章节游标。', 'Record the current execution section and advance its cursor on success.'), schema({ status: { type: 'string', enum: ['success', 'failure'] }, summary: string, evidence: strings }, ['status', 'summary'])),
    switch: tool('switch', '_switch', t('申请切换到允许的阶段，或返回普通模式。', 'Request a permitted stage transition or return to normal mode.'), schema({ mode: string, stage: string, reason: string })),
  }
}

function presentationExample(stage: string, t: Text): StageExample {
  const noTemplate = t('当前不是已确认大纲后的 Plan 视觉设计步骤，select_tools 会移除此工具。', 'This is not Plan’s visual-design step after outline confirmation; select_tools removes this tool.')
  const title = t('苏轼生平讲解', 'The life of Su Shi')
  if (stage === 'ppt_brief') return {
    worker: 'PresentationBriefThink', module: 'brief',
    persona: t('示例：把请求整理成沟通目标与制作边界；先完成 brief.md，再交给 Plan。', 'Example: establish communication goals and production boundaries; finish brief.md before handing off to Plan.'),
    entry: [t('已收到受众、时长和页数要求。', 'Audience, duration, and slide count are available.')],
    exit: [t('brief.md 已写入；影响受众和场景的歧义已解决。', 'brief.md is written; material audience and setting questions are resolved.')],
    next: 'ppt_plan',
    context: t('受众：中学生；课堂讲解；8 页、10 分钟。简报已写入 .presentation/brief.md。', 'Audience: secondary school students; classroom talk; eight slides, ten minutes. The brief is saved at .presentation/brief.md.'),
    history: t('已把“认识苏轼”细化为“理解人生经历与作品的联系”。', 'The broad topic has been refined to connecting Su Shi’s experiences with his writing.'),
    feedback: t('write_file 回执示例：.presentation/brief.md 已写入。', 'Example write_file receipt: .presentation/brief.md has been written.'),
    available: ['read_file', 'write_file', 'edit_file', 'request_human_choice', 'switch'],
    unavailable: 'report_presentation_step',
    unavailableReason: t('Brief 没有制作步骤游标，PresentationBriefThink 显式移除步骤上报工具。', 'Brief has no production-step cursor; PresentationBriefThink explicitly removes the reporting tool.'),
    before: { mode: 'presentation', stage: 'ppt_brief', brief_written: true },
    after: { mode: 'presentation', stage: 'ppt_plan', step_index: 0, brief_written: true },
    decision: t('简报已形成可交接约束，本轮调用 switch 进入资料与大纲规划。', 'The brief is ready for handoff; this request calls switch to begin evidence and outline planning.'),
    response: t('制作简报已整理好，接下来按这份简报规划页面。', 'The brief is ready. Next, I will plan the slides from it.'),
    call: { tool: 'switch', arguments: { stage: 'ppt_plan', reason: t('中学生课堂讲解，8 页、10 分钟；串联苏轼经历与作品。依据 .presentation/brief.md。', 'Eight slides for a ten-minute secondary-school talk connecting Su Shi’s life and writing. Contract: .presentation/brief.md.') }, result: { mode: null, stage: 'ppt_plan', reason: t('按已写入的简报继续规划。', 'Continue planning from the saved brief.') } },
  }
  if (stage === 'ppt_plan') {
    const slideTitles = t('认识苏轼|少年与求学|走入仕途|乌台诗案|黄州与赤壁|惠州和儋州|从诗文看苏轼|回顾与讨论', 'Meet Su Shi|Childhood and education|Public service|The poetry case|Huangzhou and Red Cliff|Huizhou and Danzhou|Su Shi through his works|Recap and discussion').split('|')
    const chapters = [{ title, summary: t('以人生阶段串联作品。', 'Connect life stages with literary works.'), slides: slideTitles.map(slideTitle => ({ title: slideTitle, content_outline: [t(`讲解“${slideTitle}”与人生主线的联系。`, `Explain how “${slideTitle}” connects with the narrative.`)], source_ids: ['source_demo_1'] })) }]
    return {
      worker: 'PresentationPlanThink', module: 'plan',
      persona: t('示例：先整理证据，再建立可编辑大纲；大纲确认之后才选择视觉方向。', 'Example: gather evidence, build an editable outline, and wait for confirmation before choosing visual direction.'),
      entry: [t('简报与示例资料已就绪；当前步骤为 map_slides。', 'The brief and sample sources are ready; the current step is map_slides.')],
      exit: [t('本次请求只提交大纲并等待用户确认。', 'This request submits the outline and waits for user confirmation.'), t('完整 Plan 还需视觉方向和 plan.md 才能进入 Compose。', 'The full Plan also requires visual direction and plan.md before Compose.')],
      next: t('等待大纲确认 → ppt_plan / design_visual_direction', 'Await outline confirmation → ppt_plan / design_visual_direction'),
      context: t('source_demo_1：用户提供的生平资料。当前正在为 8 页生成章节与页面映射；outline_confirmed=false。', 'source_demo_1: user-provided biographical material. Map chapters and eight slides; outline_confirmed=false.'),
      history: t('上一制作步骤已登记资料来源，本轮只提交页面叙事。', 'The preceding production step registered the source; this request submits the slide narrative.'),
      feedback: t('上一轮 report_presentation_step 回执示例：collect_evidence 完成，来源 source_demo_1。', 'Example preceding report_presentation_step receipt: collect_evidence completed with source_demo_1.'),
      available: ['read_file', 'write_file', 'web_search', 'report_presentation_step', 'switch'], unavailable: 'ppt_rag', unavailableReason: noTemplate,
      before: { mode: 'presentation', stage: 'ppt_plan', step_index: 1, outline_confirmed: false, interaction: 'idle' },
      after: { mode: 'presentation', stage: 'ppt_plan', step_index: 2, outline_confirmed: false, interaction: 'awaiting_outline_confirmation', slide_count: 8 },
      decision: t('用结构化 chapters 上报大纲，让运行时生成确认交互；当前不调用模板检索。', 'Report structured chapters so the runtime can request outline confirmation; template retrieval is not available yet.'),
      response: t('8 页大纲已整理，请先检查页面顺序和讲解重点。', 'The eight-slide outline is ready for review of its order and key points.'),
      call: { tool: 'report_presentation_step', arguments: { summary: t('已形成 8 页生平讲解大纲。', 'Prepared an eight-slide biographical outline.'), evidence: ['.presentation/brief.md'], data: JSON.stringify({ chapters }) }, result: { stage: 'ppt_plan', step_id: 'map_slides', status: 'awaiting_outline_confirmation', outline_confirmation_id: 'outline_demo_1' } },
    }
  }
  if (stage === 'ppt_compose') return {
    worker: 'PresentationComposeThink', module: 'compose',
    persona: t('示例：按已确认计划依次完成页面骨架、内容、视觉和全局修整；有实际页面证据才上报。', 'Example: follow the approved plan through slide shells, content, visuals, and polish; report only with live-page evidence.'),
    entry: [t('大纲与视觉方向已确认；示例中 8 页骨架已经建立。', 'The outline and visual direction are approved; eight slide shells already exist in this example.')],
    exit: [t('当前内容填充上报后，继续 create_visuals；全部制作步骤完成才进入 Review。', 'After reporting content completion, continue to create_visuals; enter Review only after every composition step.')],
    next: 'ppt_compose / create_visuals',
    context: t('当前步骤 fill_slide_content。示例页面已经填入标题、正文、引用与讲解备注，最后一次页面检查已返回。', 'Current step: fill_slide_content. In this example, titles, copy, citations, and notes are already present, and the last page inspection has returned.'),
    history: t('第 5 页以黄州经历联系《赤壁赋》，长段解释保留在讲解备注中。', 'Slide 5 connects Huangzhou with the Red Cliff writings; longer explanations remain in speaker notes.'),
    feedback: t('页面检查回执示例：1–8 页内容与备注已读取，未发现空标题。', 'Example page-inspection receipt: content and notes for slides 1–8 were read; no empty titles were found.'),
    available: ['read_file', 'write_file', 'edit_file', 'bash', 'report_presentation_step'], unavailable: 'ppt_rag', unavailableReason: noTemplate,
    before: { mode: 'presentation', stage: 'ppt_compose', step_index: 1, slides_with_content: 8, content_reported: false },
    after: { mode: 'presentation', stage: 'ppt_compose', step_index: 2, slides_with_content: 8, content_reported: true },
    decision: t('本次请求上报已完成的内容填充；上报本身不负责修改页面。', 'This request reports content that has already been composed; the report itself does not edit slides.'),
    response: t('8 页内容和讲解备注已经填入，下一步添加计划中的视觉素材。', 'Content and speaker notes are in place on all eight slides. Next come the planned visuals.'),
    call: { tool: 'report_presentation_step', arguments: { summary: t('1–8 页已填入标题、正文、引用和讲解备注。', 'Slides 1–8 contain titles, copy, citations, and speaker notes.'), evidence: [t('页面检查：1–8 页无空标题。', 'Page inspection: no empty titles on slides 1–8.')] }, result: { stage: 'ppt_compose', step_id: 'fill_slide_content', step_index: 1, next_step_index: 2 } },
  }
  return {
    worker: 'PresentationReviewThink', module: 'review',
    persona: t('示例：按叙事、证据、视觉、交付的顺序检查并修正；完成检查记录后返回 Main。', 'Example: inspect and repair narrative, evidence, visuals, and delivery; return to Main after recording the review.'),
    entry: [t('示例中四个 Review 步骤均已完成，review.md 已写入。', 'In this example, all four Review steps are complete and review.md has been written.')],
    exit: [t('交付范围和剩余限制已记录；switch 返回普通模式。', 'Delivery scope and remaining limitations are recorded; switch returns to normal mode.')], next: 'normal / main',
    context: t('已检查 8 页；第 5 页正文已精简，长解释移入备注。检查记录：.presentation/review.md。', 'Eight slides were reviewed; slide 5 was shortened, with longer explanations moved to notes. Review: .presentation/review.md.'),
    history: t('最终交付步骤已上报，本轮只结束 PPT 编排。', 'Final delivery has been reported; this request exits presentation orchestration.'),
    feedback: t('上一轮上报回执示例：confirm_delivery 完成。', 'Example preceding report receipt: confirm_delivery completed.'),
    available: ['read_file', 'write_file', 'bash', 'report_presentation_step', 'switch'], unavailable: 'ppt_rag', unavailableReason: noTemplate,
    before: { mode: 'presentation', stage: 'ppt_review', step_index: 4, review_written: true }, after: { mode: 'normal', stage: 'main', review_written: true },
    decision: t('已完成交付检查，调用 switch(mode="normal") 将控制权交回普通对话。', 'Delivery review is complete; switch(mode="normal") returns control to the main conversation.'),
    response: t('PPT 检查完成，交付范围与修正记录已整理好。', 'Presentation review is complete, with delivery scope and corrections recorded.'),
    call: { tool: 'switch', arguments: { mode: 'normal', reason: t('8 页讲解 PPT 已检查，修正记录见 .presentation/review.md。', 'The eight-slide talk has been reviewed; corrections are recorded in .presentation/review.md.') }, result: { mode: 'normal', stage: null, reason: t('PPT 交付检查完成。', 'Presentation delivery review is complete.') } },
  }
}

function buildExample(stage: string, t: Text): StageExample {
  const wrongConfirm = t('此确认工具由其他 Build 阶段添加，当前 worker 不会选入。', 'This confirmation tool is added by another Build stage and is not selected by the current worker.')
  const common = {
    module: stage,
    unavailableReason: wrongConfirm,
  }
  if (stage === 'clarify') return {
    ...common, worker: 'ClarifyThink',
    persona: t('示例：明确输入、产物和验收标准，把 task.md 提交用户确认后再开始 Explore。', 'Example: define inputs, deliverables, and acceptance criteria; obtain task.md confirmation before Explore.'),
    entry: [t('用户要求把会议文字记录整理为纪要和行动项。', 'The user requested meeting notes and action items from a transcript.')],
    exit: [t('task.md 有效；当前调用只请求确认，不等同用户已确认。', 'task.md is valid; this call requests confirmation and does not imply user approval.')],
    next: t('等待用户确认 → build / explore', 'Await user confirmation → build / explore'),
    context: t('task.md 已声明：输入会议文字记录，输出主题、决定、行动项；缺失负责人或日期标为待确认。', 'task.md defines transcript input and topics, decisions, and actions as output; absent owners or dates remain unconfirmed.'),
    history: t('已经读取示例会议记录，并写好需求文档。', 'The sample transcript has been read and the task contract has been written.'),
    feedback: t('write_file 回执示例：.build/task.md 已写入。', 'Example write_file receipt: .build/task.md has been written.'),
    available: ['read_file', 'write_file', 'edit_file', 'request_human_task_confirm', 'switch'], unavailable: 'request_human_workflow_confirm',
    before: { mode: 'build', stage: 'clarify', task_written: true, interaction: 'idle' }, after: { mode: 'build', stage: 'clarify', task_written: true, interaction: 'awaiting_task_confirm' },
    decision: t('需求文档已满足检查条件，提交确认卡片；当前不直接切换 Explore。', 'The task contract is ready for a confirmation card; this request does not switch directly to Explore.'),
    response: t('需求已整理，请确认这份工作流的输入、产物和缺失信息处理方式。', 'Please confirm the workflow’s inputs, outputs, and treatment of missing information.'),
    call: { tool: 'request_human_task_confirm', arguments: {}, result: { request_id: 'task_demo_1', operation: 'create', status: 'pending' } },
  }
  if (stage === 'explore') return {
    ...common, worker: 'ExploreThink',
    persona: t('示例：验证实现路径，记录可执行的操作顺序与准备条件，写入 explore.md。', 'Example: establish a workable approach, record its operation sequence and prerequisites in explore.md.'),
    entry: [t('task.md 已由用户确认；输入样例可读取。', 'The user confirmed task.md and the input sample is readable.')],
    exit: [t('explore.md 已记录读取、结构化提取和输出检查步骤。', 'explore.md records input reading, structured extraction, and output checks.')], next: 'build / generate',
    context: t('样例中“回归测试需要安排”没有负责人；方案保留待确认，不补造姓名。无需外部账号或第三方包。', 'The sample assigns no owner for regression testing; the approach preserves that uncertainty. No external account or third-party package is needed.'),
    history: t('方案已用示例记录逐步核对，准备把明确步骤交给 Generate。', 'The approach was checked against the sample and is ready for Generate.'),
    feedback: t('write_file 回执示例：.build/explore.md 已写入。', 'Example write_file receipt: .build/explore.md has been written.'),
    available: ['read_file', 'write_file', 'bash', 'web_search', 'switch'], unavailable: 'request_human_task_confirm',
    before: { mode: 'build', stage: 'explore', explore_written: true }, after: { mode: 'build', stage: 'generate', explore_written: true },
    decision: t('实施顺序和依赖已明确，调用 switch 将 explore.md 作为 Generate 的依据。', 'The operation sequence and prerequisites are established; switch hands explore.md to Generate.'),
    response: t('实现方案已整理，接下来生成可复用的工作流说明。', 'The approach is ready. Next comes the reusable workflow package.'),
    call: { tool: 'switch', arguments: { stage: 'generate', reason: t('读取会议记录 → 提取主题、决定、行动项 → 检查并输出。依据 .build/explore.md。', 'Read the transcript → extract topics, decisions, and actions → check and output. Approach: .build/explore.md.') }, result: { mode: null, stage: 'generate', reason: t('实施方案已写入。', 'The implementation approach is recorded.') } },
  }
  if (stage === 'generate') {
    const content = t('---\nname: meeting-notes\ndescription: 将会议文字记录整理为纪要\n---\n\n# 读取资料\n读取用户提供的会议文字记录。\n\n# 整理内容\n提取主题、决定、行动项；缺失信息标为待确认，中间结果写入 background/work/。\n\n# 检查并交付\n核对信息来源，将会议纪要写入运行时提供的最终结果目录。', '---\nname: meeting-notes\ndescription: Turn a meeting transcript into structured notes\n---\n\n# Read the material\nRead the transcript supplied by the user.\n\n# Organize the content\nExtract topics, decisions, and actions; preserve missing details as unconfirmed. Write intermediate results under background/work/.\n\n# Check and deliver\nCheck source support and write meeting notes to the runtime-provided final-result directory.')
    return {
      ...common, worker: 'GenerateThink',
      persona: t('示例：按 task.md 和 explore.md 生成 .build/workflow/ 包，使用一级标题定义运行步骤。', 'Example: generate the .build/workflow/ package from task.md and explore.md, using level-one headings for execution sections.'),
      entry: [t('任务与实施方案已固定，工作流采用三个 Agent 执行步骤。', 'The task and approach are established; the workflow uses three Agent execution sections.')],
      exit: [t('本轮写入 WORKFLOW.md；结构验证通过后，后续调用才能切换 Verify。', 'This request writes WORKFLOW.md; a subsequent call can enter Verify after structural validation.')], next: t('build / generate：检查后切换 verify', 'build / generate: validate, then switch to verify'),
      context: t('产物目录：.build/workflow/。本案例无需脚本；所有步骤需要保留来源与缺失字段。', 'Package directory: .build/workflow/. This example needs no script; all sections preserve sources and missing fields.'),
      history: t('已读取 task.md 与 explore.md，准备写入三节执行说明。', 'task.md and explore.md were read; three execution sections are ready to write.'),
      feedback: t('read_file 回执示例：explore.md 要求保留相对日期，不猜测绝对日期。', 'Example read_file receipt: explore.md requires retaining relative dates without guessing calendar dates.'),
      available: ['read_file', 'write_file', 'edit_file', 'bash', 'switch'], unavailable: 'request_human_workflow_confirm',
      before: { mode: 'build', stage: 'generate', workflow_written: false, verified: false }, after: { mode: 'build', stage: 'generate', workflow_written: true, verified: false },
      decision: t('将已确定的操作顺序写成 WORKFLOW.md；文件写入不会自动完成验证。', 'Write the established sequence into WORKFLOW.md; writing the file does not complete verification.'),
      response: t('工作流草稿已写入，接下来检查结构与示例运行结果。', 'The workflow draft is written. Next, its structure and sample behavior need checking.'),
      call: { tool: 'write_file', arguments: { file_path: '.build/workflow/WORKFLOW.md', content }, result: { text: t('示例回执：Created .build/workflow/WORKFLOW.md。', 'Example receipt: Created .build/workflow/WORKFLOW.md.') } },
    }
  }
  return {
    ...common, worker: 'VerifyThink',
    persona: t('示例：按任务验收条件检查工作流，记录实际验证范围；verify.md 通过后请求用户确认。', 'Example: verify against task acceptance criteria, record the tested scope, and request user confirmation after verify.md passes.'),
    entry: [t('示例中工作流已完成样例检查，verify.md 以整体结论 PASS 结束。', 'In this example, sample checks are complete and verify.md ends with an overall PASS.')],
    exit: [t('当前调用生成确认卡片；用户确认之前不视为已经保存。', 'This call creates a confirmation card; the workflow is not considered saved until the user confirms.')],
    next: t('等待工作流确认', 'Await workflow confirmation'),
    context: t('已检查：负责人提取、缺失字段保留、相对日期保留。verify.md 记录使用本地样例，没有外部发送。', 'Checks cover owner extraction, missing fields, and relative dates. verify.md records local-sample checks with no external delivery.'),
    history: t('验证记录与生成产物均已复核，本轮提交命名确认。', 'The verification record and generated package were checked; this request asks for naming and confirmation.'),
    feedback: t('read_file 回执示例：verify.md 最后两行为“## 整体结论”和“PASS”。', 'Example read_file receipt: verify.md ends with “## Overall verdict” and “PASS”.'),
    available: ['read_file', 'write_file', 'bash', 'request_human_workflow_confirm', 'switch'], unavailable: 'request_human_task_confirm',
    before: { mode: 'build', stage: 'verify', verified: true, interaction: 'idle' }, after: { mode: 'build', stage: 'verify', verified: true, interaction: 'awaiting_workflow_confirm' },
    decision: t('验证记录符合确认门槛，生成工作流命名卡片并暂停。', 'The verification record meets the confirmation gate; create the naming card and pause.'),
    response: t('示例检查已通过，请确认工作流名称后保存。', 'The sample checks passed. Please confirm the workflow name to save it.'),
    call: { tool: 'request_human_workflow_confirm', arguments: { prompt: JSON.stringify({ default_name: t('会议纪要整理', 'Meeting notes'), summary: t('提取主题、决定与行动项，保留缺失信息。', 'Extract topics, decisions, and actions while preserving missing information.') }) }, result: { request_id: 'workflow_demo_1', default_name: t('会议纪要整理', 'Meeting notes'), operation: 'create', status: 'pending' } },
  }
}

function workflowExample(index: number, t: Text): StageExample {
  const sections = [
    { title: t('准备资料', 'Prepare the materials'), instruction: t('读取本周项目更新，整理来源和负责人，中间结果保存到 background/work/。', 'Read this week’s project updates, retain sources and owners, and save intermediate material under background/work/.'), artifact: 'background/work/weekly-updates.md', summary: t('已读取 3 条项目更新，保留负责人和来源。', 'Read three project updates with owners and sources preserved.') },
    { title: t('汇总分析', 'Summarize the progress'), instruction: t('从已整理资料中归纳完成、进行中和风险，不推测未提供的交付日期。', 'Summarize completed work, ongoing work, and risks without inventing delivery dates.'), artifact: 'background/work/progress-summary.md', summary: t('已整理完成、进行中和风险各 1 项，外部接口资料缺失需跟进。', 'Organized one completed item, one ongoing item, and one risk; missing external API documentation needs follow-up.') },
    { title: t('整理交付', 'Prepare the deliverable'), instruction: t('核对汇总和来源，将周报草稿写入最终结果目录，不向外部发送。', 'Check the summary against its sources and write a report draft to the final-result directory without sending it externally.'), artifact: 'result/weekly-report.md', summary: t('周报草稿已写入，包含 3 条进展与 1 项跟进建议，尚未发送。', 'The report draft contains three updates and one follow-up recommendation; it has not been sent.') },
  ]
  const section = sections[index]!
  const final = index === sections.length - 1
  return {
    worker: 'WorkflowThink', module: 'execute',
    persona: t('示例：执行 WORKFLOW.md 当前章节，完成后上报；运行时推进步骤，cognitive stage 始终为 execute。', 'Example: execute the current WORKFLOW.md section and report its result; the runtime advances sections while the cognitive stage remains execute.'),
    entry: [t(`示例工作流第 ${index + 1} 节：${section.title}。`, `Example workflow section ${index + 1}: ${section.title}.`), t('上下文只注入当前章节的完整指令。', 'The context injects the full instruction for the current section only.')],
    exit: [t('本次请求上报此前已经完成的章节工作，不代替文件读取或写入。', 'This request reports work already completed for this section; it does not replace file reading or writing.')],
    next: final ? t('发布完成结果 → normal / main', 'Publish the completed result → normal / main') : `run_workflow / execute · ${sections[index + 1]!.title}`,
    context: `mode=run_workflow; stage=execute; step_index=${index}\n${section.instruction}\n${t('原始输入：汇总本周项目进展，生成草稿。', 'Original input: summarize this week’s project progress into a draft.')}`,
    history: index === 0 ? t('本节已读取本周更新，并保存保留来源的中间资料。', 'This section has read weekly updates and saved intermediate material with source references.') : t(`上一节“${sections[index - 1]!.title}”已上报成功；本节的产物也已写入。`, `The previous section, “${sections[index - 1]!.title}”, was reported successfully; this section’s artifact has now been written.`),
    feedback: t(`write_file 回执示例：${section.artifact} 已写入。`, `Example write_file receipt: ${section.artifact} has been written.`),
    available: ['read_file', 'write_file', 'grep', 'bash', 'report_workflow_step'], unavailable: 'request_human_workflow_confirm',
    unavailableReason: t('这是执行已保存工作流的 worker，Build Verify 的保存确认工具不在它的工具集合中。', 'This worker executes a saved workflow; Build Verify’s save-confirmation tool is not in its toolset.'),
    before: { mode: 'run_workflow', stage: 'execute', step_index: index, step_count: 3, artifact: section.artifact, artifact_written: true, report_recorded: false },
    after: { mode: final ? 'normal' : 'run_workflow', stage: final ? 'main' : 'execute', step_index: index + 1, step_count: 3, artifact: section.artifact, artifact_written: true, report_recorded: true, run_status: final ? 'completed' : 'running' },
    decision: t('当前章节产物已有文件回执，调用 report_workflow_step 记录证据并推进；不手动 switch 到其他执行阶段。', 'The artifact has a write receipt; report_workflow_step records the evidence and advances the cursor, without switching to a different execution stage.'),
    response: section.summary,
    call: { tool: 'report_workflow_step', arguments: { status: 'success', summary: section.summary, evidence: [section.artifact] }, result: { workflow_id: 'weekly-progress-demo', phase: 'execute', step_index: index, step_number: index + 1, step_count: 3, title: section.title, status: 'success', summary: section.summary, evidence: [section.artifact], ...(final ? { run_status: 'completed', published_result_dir: 'result/' } : {}) } },
  }
}

/** Source paths are real; all messages, requests, receipts, and states are examples. */
export function getDebugStage(scenarioId: ScenarioId, stageId: string, locale: Locale): DebugStage {
  const t: Text = (zh, en) => locale === 'zh-CN' ? zh : en
  const scenario = getDemoScenarios(locale).find(item => item.id === scenarioId)!
  const stageIndex = scenario.stages.findIndex(item => item.id === stageId)
  if (stageIndex < 0) throw new Error(`Unknown ${scenarioId} demo stage: ${stageId}`)
  const stage = scenario.stages[stageIndex]!
  const group = scenarioId === 'presentation' ? 'presentation' : scenarioId === 'build' ? 'build' : 'workflow'
  const example = scenarioId === 'presentation' ? presentationExample(stageId, t) : scenarioId === 'build' ? buildExample(stageId, t) : workflowExample(stageIndex, t)
  const cognitiveSource = `${ROOT}/cognitive/${group}/${example.module}.py`
  const promptSource = `${ROOT}/prompts/${group}/${example.module}.py`
  const assemblySource = `${ROOT}/cognitive/${group}/base.py`
  const catalog = toolCatalog(t)
  const tools: DebugTool[] = [
    ...example.available.map(name => ({ ...catalog[name]!, availability: 'available' as const, reason: t('当前示例 worker 选入的工具之一；这里仅展示相关子集。', 'One of the tools selected by this example’s worker; only a relevant subset is shown.') })),
    { ...catalog[example.unavailable]!, availability: 'unavailable', reason: example.unavailableReason },
  ]
  const sample = (content: string) => `${t('示例内容，非源文件原文：', 'Example content, not a quotation from the source:')}\n${content}`
  const blocks: DebugPromptBlock[] = [
    { id: 'persona', label: t('角色与阶段目标', 'Persona and stage goal'), role: 'system', source: promptSource, content: sample(example.persona) },
    { id: 'context', label: t('实时上下文', 'Live context'), role: 'system', source: assemblySource, content: sample(example.context) },
    { id: 'history', label: t('保留的对话', 'Retained conversation'), role: 'assistant', source: `${ROOT}/cognitive/base.py`, content: sample(example.history) },
    { id: 'user', label: t('当前用户输入', 'Current user input'), role: 'user', source: `${ROOT}/cognitive/base.py`, content: sample(scenario.input) },
    { id: 'feedback', label: t('此前工具活动摘要', 'Prior tool activity summary'), role: 'assistant', source: `${ROOT}/cognitive/base.py`, content: sample(`${t('原始调用参数已省略，因此用 assistant 文本摘要保留历史工具活动；此处不是原生 tool 消息。', 'Original call arguments are omitted, so historical tool activity is retained as an assistant text summary, not a native tool message.')}\n${example.feedback}`) },
  ]
  const call = example.call
  if (call.tool === 'switch') {
    call.result = {
      mode: call.arguments.mode || null,
      stage: call.arguments.stage || null,
      reason: call.arguments.reason || null,
    }
  } else if (call.tool === 'report_presentation_step') {
    call.result = {
      mode: 'presentation',
      stage: stageId,
      step_index: example.before.step_index,
      next_step_index: example.after.step_index,
      summary: call.arguments.summary,
      evidence: call.arguments.evidence ?? [],
      data: typeof call.arguments.data === 'string' ? JSON.parse(call.arguments.data) : {},
      ...call.result,
    }
  }
  return {
    mode: scenarioId === 'workflow' ? 'run_workflow' : scenarioId,
    worker: example.worker, cognitiveSource, promptSource,
    purpose: scenarioId === 'workflow' ? t(`Execute 内的示例步骤：${stage.title}。三步共用同一个 cognitive worker。`, `Example section within Execute: ${stage.title}. All three sections share one cognitive worker.`) : stage.description,
    entry: example.entry, exit: example.exit, nextStage: example.next,
    blocks, tools, before: example.before, after: example.after,
    decision: example.decision, response: example.response, call,
  }
}
