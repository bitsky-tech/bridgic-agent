/**
 * Exact response text from one historical PPT execution, read from state.db without changes.
 * Only output and exposed reasoning text are recorded here. The surrounding presentation
 * fixture still contains illustrative prompts, tools, inspection descriptions, and metrics;
 * importing these responses does not make that mixed fixture a complete historical replay.
 * Null means the text field was absent or null. An empty string is preserved as recorded.
 */
export interface PresentationResponseSnapshotRound {
  output: string | null
  thinking: string | null
  outputFidelity?: 'recorded'
  thinkingFidelity?: 'recorded'
}

export const presentationResponseSnapshotSource = {
  "kind": "historical_record",
  "database": "state.db",
  "sessionId": "session_20260908_185701_6bbd88d2",
  "turnId": "turn_4a85c5930bf3cb54",
  "sessionTitle": "制作佛教讲解PPT",
  "turnCreatedAt": "2026-09-08 11:00:00.733960",
  "outputField": "think_result.step_content",
  "thinkingField": "reasoning_content"
} as const

export const presentationResponseSnapshot: Readonly<Record<string, PresentationResponseSnapshotRound>> = {
  "R01": {
    "output": "我会先梳理这份 PPT 的受众、结构与视觉表达，再制作一套适合讲解佛教基础知识的演示文稿。",
    "thinking": null,
    "outputFidelity": "recorded"
  },
  "R02": {
    "output": "为避免内容深度与表达方式不匹配，我需要先确定这套讲解的听众和使用场景。",
    "thinking": "**Planning brief questions**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  },
  "R03": {
    "output": "已确定为面向中学生或大学通识课堂学生、可自行阅读传播的教学型内容；我会据此采用清晰的概念释义和自足的信息呈现。",
    "thinking": "**Verifying directory creation prerequisites**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  },
  "R04": {
    "output": "我已把受众与使用方式纳入沟通约定，接下来将以零基础友好的教学表达组织后续内容。",
    "thinking": "**Inspecting artifact presence and stage requirements**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  },
  "R05": {
    "output": "",
    "thinking": "**Deciding to implement switch statement**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  },
  "R06": {
    "output": "我先为内容框架收集少量权威、适合课堂引用的基础资料，重点覆盖历史起源、核心概念、传统分支与当代分布。",
    "thinking": null,
    "outputFidelity": "recorded"
  },
  "R07": {
    "output": "",
    "thinking": "**Planning web fetch from official sources**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  },
  "R08": {
    "output": "",
    "thinking": "**Evaluating source sufficiency and authority****Identifying authoritative Buddhism sources**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  },
  "R09": {
    "output": "",
    "thinking": "**Planning source registration without excerpts**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  },
  "R10": {
    "output": "",
    "thinking": "**Mapping slides with source IDs**",
    "outputFidelity": "recorded",
    "thinkingFidelity": "recorded"
  }
}
