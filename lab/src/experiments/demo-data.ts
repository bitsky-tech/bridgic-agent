export type ScenarioId = 'presentation' | 'build' | 'workflow'

export interface DemoStage {
  id: string
  title: string
  description: string
}

export interface DemoScenario {
  id: ScenarioId
  title: string
  name: string
  description: string
  input: string
  stages: DemoStage[]
}

/** Static scenario navigation and sample inputs; execution examples live in debug-data. */
export function getDemoScenarios(locale: 'zh-CN' | 'en-US'): DemoScenario[] {
  const text = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  return [
    {
      id: 'presentation',
      title: text('PPT 编排', 'Presentation orchestration'),
      name: text('苏轼生平讲解 PPT', 'A presentation about Su Shi'),
      description: text('从演示需求到逐页内容，查看简报、规划、制作与检查的衔接。', 'Follow a presentation from its brief through planning, composition, and review.'),
      input: text('为中学生制作一份讲解苏轼生平的 PPT，约 10 分钟、8 页。按人生经历串联代表作品，语言通俗，并附每页讲解提示。', 'Create an eight-slide, ten-minute presentation about Su Shi for secondary school students. Connect his life with representative works, use accessible language, and include speaker notes.'),
      stages: [
        {
          id: 'ppt_brief',
          title: text('明确需求', 'Define the brief'),
          description: text('把受众、时长与讲解目标整理成制作依据。', 'Establish the audience, duration, and teaching goals.'),
        },
        {
          id: 'ppt_plan',
          title: text('规划页面', 'Plan the slides'),
          description: text('将故事拆成逐页主题，并分配讲解时间。', 'Divide the narrative into slide topics and allocate speaking time.'),
        },
        {
          id: 'ppt_compose',
          title: text('制作内容', 'Compose the presentation'),
          description: text('把逐页计划转成适合观看和讲解的内容。', 'Turn the plan into slide content and speaker notes.'),
        },
        {
          id: 'ppt_review',
          title: text('检查交付', 'Review the result'),
          description: text('检查内容衔接、可读性与讲解节奏。', 'Review narrative continuity, readability, and pacing.'),
        },
      ],
    },
    {
      id: 'build',
      title: text('工作流构建', 'Workflow construction'),
      name: text('会议纪要整理工作流', 'A meeting-notes workflow'),
      description: text('把一个重复需求整理成可检查的工作流草稿。', 'Turn a recurring need into an inspectable workflow draft.'),
      input: text('帮我设计一个会议纪要整理工作流：输入会议逐字记录，输出议题摘要、决策与待办；负责人或截止日期不明确时保留待确认，不能自行补全。', 'Design a workflow that turns a meeting transcript into topic summaries, decisions, and action items. Mark missing owners or due dates for confirmation instead of inventing them.'),
      stages: [
        {
          id: 'clarify',
          title: text('明确目标', 'Clarify the goal'),
          description: text('确定输入、输出和不能替用户作出的判断。', 'Define the inputs, outputs, and decisions that require confirmation.'),
        },
        {
          id: 'explore',
          title: text('梳理步骤', 'Explore the steps'),
          description: text('确定任务划分与步骤之间需要传递的数据。', 'Define the tasks and the information passed between them.'),
        },
        {
          id: 'generate',
          title: text('生成草稿', 'Generate the draft'),
          description: text('写出工作流步骤说明与输入输出约定。', 'Draft the workflow steps and their input/output requirements.'),
        },
        {
          id: 'verify',
          title: text('检查方案', 'Verify the plan'),
          description: text('用样例核对草稿是否遵守约束。', 'Check the draft against the sample and its constraints.'),
        },
      ],
    },
    {
      id: 'workflow',
      title: text('工作流执行', 'Workflow execution'),
      name: text('每周项目进展汇总', 'Weekly project progress summary'),
      description: text('以执行过程中的三个示例步骤，展示资料如何变成一份周报。', 'Inspect three example steps within an execution, from source updates to a weekly report.'),
      input: text('汇总本周项目更新，按已完成、进行中和风险整理，保留负责人及原文依据。输出周报草稿，涉及外部发送的操作留给我确认。', 'Summarize this week’s project updates into completed work, work in progress, and risks. Retain owners and source references. Produce a draft report and leave any external sharing for my confirmation.'),
      stages: [
        {
          id: 'prepare_materials',
          title: text('准备资料', 'Prepare the materials'),
          description: text('示例执行步骤一：读取输入，确认汇总范围。', 'Example execution step 1: read the inputs and establish the scope.'),
        },
        {
          id: 'summarize_progress',
          title: text('汇总分析', 'Summarize the progress'),
          description: text('示例执行步骤二：整理进展与需要关注的风险。', 'Example execution step 2: organize progress and risks that need attention.'),
        },
        {
          id: 'prepare_delivery',
          title: text('整理交付', 'Prepare the deliverable'),
          description: text('示例执行步骤三：检查周报，保存交付草稿。', 'Example execution step 3: review the report and save the deliverable draft.'),
        },
      ],
    },
  ]
}
