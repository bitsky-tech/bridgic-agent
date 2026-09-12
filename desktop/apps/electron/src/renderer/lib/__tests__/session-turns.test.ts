import { describe, expect, it } from 'bun:test'
import type { AgentMessage, SessionTurnRecord, WorkflowRunState } from '@shared/types'
import { sessionTurnsToMessages, resolveWorkflowStepMetadata } from '../sessionTurns'
import { AmphiClient } from '../amphiClient'

const scope = { mode: 'run_workflow', stage: 'execute' }
const run: WorkflowRunState = { workflowId: 'wf', generation: 'gen', workflowName: 'Directory', sourceSessionId: 'session', phase: 'execute', stepIndex: 0, executionSteps: ['Choose directory', 'Scan directory'] }
const cursor = { ...scope, workflow_id: 'wf', generation: 'gen', step_index: 0 }
const workflowEntry = {
  think_scope: { mode: 'normal', stage: 'main' }, reasoning_content: 'Starting workflow', action_result: { results: [{
    tool_name: 'request_run_workflow', success: true,
    tool_result: { status: 'started', workflow_id: 'wf', workflow_name: 'Directory', execution_steps: run.executionSteps },
  }] },
}
const report = (stepIndex: number) => ({ tool_name: 'report_workflow_step', tool_result: {
  workflow_id: 'wf', generation: 'gen', workflow_name: 'Directory', phase: 'execute', step_index: stepIndex,
  step_count: 2, title: run.executionSteps[stepIndex], execution_steps: run.executionSteps, status: 'success', summary: 'Done',
} })
function turn(overrides: Partial<SessionTurnRecord> = {}): SessionTurnRecord {
  return {
    id: 'turn', user_id: 'local', session_id: 'session', session_ordinal: 0, user_input: { text: 'Summarize', blocks: [] },
    ota_records: [], agent_state: { think: cursor }, status: 'awaiting_human', final_answer: null, error: null,
    model: 'model', execution_mode: 'auto', max_rounds: 20, browser_tool_loaded: false, workspace_tools_loaded: false,
    skills_tool_loaded: false, context_usage: {}, created_at: '2026-09-11T00:00:00Z', ...overrides,
  }
}
const assistant = (messages: AgentMessage[]) => messages.find((message) => message.role === 'assistant')!
const headings = (message: AgentMessage) => message.blocks!.filter((block) => block.type === 'workflow_step')

describe('Session Turn display projection', () => {
  for (const scoped of [false, true]) for (const state of ['awaiting', 'answered', 'resumed', 'awaiting_again', 'answered_again', 'reported']) {
    it(`keeps the first OTA boundary across ${state} (scoped=${scoped})`, () => {
      const records: Record<string, unknown>[] = [
        { think_result: { step_content: 'Starting workflow' }, action_result: { results: [{ tool_name: 'request_run_workflow', tool_result: { status: 'started' } }] } },
        { reasoning_content: 'Planning the directory question', action_result: { results: [{ tool_name: 'request_human_choice', tool_arguments: { questions: [{ question: 'Which directory?' }] }, tool_result: state === 'awaiting' ? null : '/tmp/project' }] } },
      ]
      if (['resumed', 'awaiting_again', 'answered_again', 'reported'].includes(state)) records.push({ reasoning_content: 'Checking the directory' })
      if (['awaiting_again', 'answered_again', 'reported'].includes(state)) records.push({ action_result: { results: [{ tool_name: 'request_human_choice', tool_arguments: { questions: [{ question: 'Use it?' }] }, tool_result: state === 'awaiting_again' ? null : 'Yes' }] } })
      if (state === 'reported') records.push({ action_result: { results: [report(0)] } }, { reasoning_content: 'Scanning the directory' })
      if (scoped) records.forEach((round, index) => { round.think_scope = index ? scope : { mode: 'normal', stage: 'main' } })
      const input = turn({ ota_records: records, agent_state: { think: { ...cursor, step_index: state === 'reported' ? 1 : 0 }, interaction: { questions: [{ question: 'Which directory?' }] } } })
      const original = structuredClone(input)
      const message = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([input], { showPendingInteraction: true }), run))
      expect(message.turnId).toBe(input.id)
      expect(message.blocks![0]).toEqual({ type: 'text', text: 'Starting workflow' })
      expect(message.blocks![1]).toMatchObject({ type: 'workflow_step', title: 'Choose directory', status: state === 'reported' ? 'success' : 'running' })
      expect(message.blocks![2]).toEqual({ type: 'thinking', text: 'Planning the directory question' })
      expect(headings(message)).toHaveLength(state === 'reported' ? 2 : 1)
      let confirmations = ['answered_again', 'reported'].includes(state) ? 2 : 1
      if (state === 'awaiting') confirmations = 0
      expect(message.blocks!.filter((block) => block.type === 'confirmation')).toHaveLength(confirmations)
      expect(input).toEqual(original)
    })
  }
  for (const status of ['cancelled', 'failed'] as const) it(`preserves a ${status} Turn after another Turn completes, including pagination`, () => {
    const old = turn({ status, error: status === 'failed' ? 'Failed' : null, ota_records: [{ think_scope: scope, reasoning_content: 'Original check' }] })
    const resumed = turn({ id: 'resumed', session_ordinal: 1, status: 'completed', agent_state: {}, ota_records: [
      { think_scope: scope, reasoning_content: 'Continue', action_result: { results: [report(0)] } },
      { think_scope: scope, reasoning_content: 'Scan', action_result: { results: [report(1)] } },
    ] })
    const initial = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([old]), run))
    const historical = assistant(resolveWorkflowStepMetadata([...sessionTurnsToMessages([old]), ...sessionTurnsToMessages([resumed])]))
    expect(headings(historical)).toEqual(headings(initial))
    expect(historical.blocks![1]).toEqual({ type: 'thinking', text: 'Original check' })
    expect(headings(historical)[0]!.status).toBe(status === 'failed' ? 'failure' : 'neutral')
    expect(headings(assistant(sessionTurnsToMessages([resumed]))).map((block) => block.status)).toEqual(['success', 'success'])
  })
  it('uses the historical cursor and never labels it from another generation', () => {
    const messages = sessionTurnsToMessages([turn({ status: 'cancelled', ota_records: [{ think_scope: scope, reasoning_content: 'Old work' }] })])
    expect(headings(assistant(resolveWorkflowStepMetadata(messages, { ...run, stepIndex: 1 })))[0]).toMatchObject({ stepIndex: 0, title: 'Choose directory', status: 'neutral' })
    expect(headings(assistant(resolveWorkflowStepMetadata(messages, { ...run, generation: 'other', executionSteps: ['Other'] })))[0]).toMatchObject({ generation: 'gen', title: '', stepCount: 0 })
  })
  it('does not create an empty next section after a report', () => {
    const message = assistant(sessionTurnsToMessages([turn({ agent_state: { think: { ...cursor, step_index: 1 } }, ota_records: [{ think_scope: scope, reasoning_content: 'Work', action_result: { results: [report(0)] } }] })]))
    expect(headings(message).map((step) => step.stepIndex)).toEqual([0])
  })
  for (const scoped of [false, true]) it(`retains a stage whose first OTA only asks a human question (scoped=${scoped})`, () => {
    const questions = [{ question: 'Which directory?', options: [{ label: 'Project' }, { label: 'Downloads' }] }]
    const choice = { tool_name: 'request_human_choice', success: true,
      tool_arguments: { questions: JSON.stringify({ questions }), prompt: 'Choose the directory to scan.' }, tool_result: questions,
    }
    const records = [workflowEntry, { think_scope: scope, action_result: { results: [choice] } }]
      .map((round) => scoped ? round : Object.fromEntries(Object.entries(round).filter(([key]) => key !== 'think_scope')))
    const pending = turn({ ota_records: records, agent_state: { think: cursor, interaction: { questions } } })
    const message = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([pending], { showPendingInteraction: true }), run))
    expect(message.blocks!.map((block) => block.type)).toEqual(['thinking', 'workflow_step'])
    expect(headings(message)[0]).toMatchObject({ stepIndex: 0, stepCount: 2, title: 'Choose directory', status: 'running' })
    const answered = structuredClone(pending)
    answered.ota_records![1]!.action_result = { results: [{ ...choice, tool_result: 'Project' }] }
    const resumed = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([answered]), run))
    expect(headings(resumed)).toEqual(headings(message))
    expect(resumed.blocks![2]).toMatchObject({ type: 'confirmation', response: 'Project' })
  })

  describe('retained Run positions', () => {
    const main = { mode: 'normal', stage: 'main' }
    const exitRound = { think_scope: scope, action_result: { results: [{ tool_name: 'switch', success: true, tool_result: { mode: 'normal' } }] } }
    const entry = (status: 'resumed' | 'restarted') => ({ ...workflowEntry, action_result: { results: [{
      tool_name: 'request_run_workflow', success: true,
      tool_result: { status, workflow_id: 'wf', workflow_name: 'Directory', execution_steps: run.executionSteps },
    }] } })
    const exited = turn({ status: 'completed', agent_state: { think: main }, ota_records: [
      workflowEntry, { think_scope: scope, action_result: { results: [report(0)] } }, exitRound,
    ] })
    const resumed = (ordinal: number) => turn({ id: `resumed-${ordinal}`, session_ordinal: ordinal,
      status: 'completed', agent_state: { think: main }, ota_records: [entry('resumed'), exitRound],
    })
    // Load newest pages first, resolving each merge just like transcript paging.
    const paged = (records: SessionTurnRecord[], pageMask: number) => {
      const pages: SessionTurnRecord[][] = [[]]
      records.forEach((record, index) => {
        if (index && pageMask & (1 << (index - 1))) pages.push([])
        pages.at(-1)!.push(record)
      })
      return pages.reduceRight((messages, page) => resolveWorkflowStepMetadata([...sessionTurnsToMessages(page), ...messages]), [] as AgentMessage[])
    }

    it('keeps the retained step across exits, Main Turns and every history page boundary', () => {
      const records = [exited,
        turn({ id: 'main', session_ordinal: 1, status: 'completed', agent_state: { think: main }, ota_records: [{ think_scope: main, reasoning_content: 'Unrelated conversation' }] }),
        resumed(2), resumed(3),
      ]
      const original = structuredClone(records)
      const whole = resolveWorkflowStepMetadata(sessionTurnsToMessages(records))
      for (let mask = 0; mask < 8; mask += 1) {
        const messages = paged(records, mask)
        for (const ordinal of [2, 3]) {
          const message = messages.find((row) => row.id === `session:${ordinal}`)!
          expect(headings(message)).toEqual(headings(whole.find((row) => row.id === message.id)!))
          expect(headings(message)[0]).toMatchObject({ generation: 'gen', stepIndex: 1, title: 'Scan directory', stepCount: 2, status: 'neutral' })
        }
        expect(resolveWorkflowStepMetadata(messages)).toEqual(messages)
      }
      expect(records).toEqual(original)
    })

    it('does not inherit across a missing Turn or another Session', () => {
      const missing = resolveWorkflowStepMetadata([...sessionTurnsToMessages([exited]), ...sessionTurnsToMessages([resumed(2)])])
      expect(headings(missing.at(-1)!)[0]).toMatchObject({ stepIndex: -1, title: '' })
      const other = resolveWorkflowStepMetadata([...sessionTurnsToMessages([{ ...exited, session_id: 'other' }]), ...sessionTurnsToMessages([resumed(1)])])
      expect(headings(other.at(-1)!)[0]).toMatchObject({ stepIndex: -1, title: '' })
    })

    it('resolves a retained legacy validation step without first assigning the wrong title', () => {
      const validationSteps = ['Check format', 'Check totals']
      const before = turn({ status: 'cancelled', agent_state: { think: { ...cursor, stage: 'validate', step_index: 1 } } })
      const after = turn({ id: 'validation', session_ordinal: 1, status: 'completed', agent_state: { think: main }, ota_records: [
        { think_scope: main, action_result: { results: [{ ...entry('resumed').action_result.results[0],
          tool_result: { ...entry('resumed').action_result.results[0]!.tool_result, validation_steps: validationSteps },
        }] } },
        { ...exitRound, think_scope: { ...scope, stage: 'validate' } },
      ] })
      const missing = assistant(sessionTurnsToMessages([after]))
      expect(headings(missing)[0]).toMatchObject({ phase: 'validate', stepIndex: -1, title: '' })
      const merged = paged([before, after], 1).at(-1)!
      expect(headings(merged)[0]).toMatchObject({ phase: 'validate', stepIndex: 1, title: 'Check totals' })
      expect(headings(merged)).toEqual(headings(paged([before, after], 0).at(-1)!))
    })

    it('resumes the locally restarted first step without inheriting the old generation', () => {
      const previous = turn({ ...exited, status: 'cancelled', agent_state: { think: { ...cursor, step_index: 1 } }, ota_records: exited.ota_records!.slice(0, 2) })
      const restarted = turn({ id: 'restart', session_ordinal: 1, status: 'completed', agent_state: { think: main }, ota_records: [
        exitRound, entry('restarted'), exitRound, entry('resumed'), exitRound,
      ] })
      const records = [previous, restarted, resumed(2)]
      for (let mask = 0; mask < 4; mask += 1) {
        const messages = paged(records, mask)
        const stages = headings(messages.find((row) => row.id === 'session:1')!)
        expect(stages.map(({ stepIndex, title }) => [stepIndex, title])).toEqual([[1, 'Scan directory'], [0, 'Choose directory'], [0, 'Choose directory']])
        expect(stages[1]!.generation).not.toBe('gen')
        expect(stages[2]!.generation).toBe(stages[1]!.generation)
        expect(stages[2]!.inheritedCursor).toBeUndefined()
        expect(stages[1]!.historySection).not.toBe(stages[2]!.historySection)
        expect(headings(messages.at(-1)!)[0]).toMatchObject({ generation: stages[1]!.generation, stepIndex: 0, title: 'Choose directory' })
      }
    })

    for (const terminalKind of ['report', 'entry', 'result'] as const) it(`clears the retained cursor at ${terminalKind} publication`, () => {
      const result = { run_id: 'result', workflow_id: 'wf', workflow_name: 'Directory', status: 'completed', created_at: '2026-09-11T00:00:00Z' }
      const terminalRounds = {
        report: { think_scope: scope, action_result: { results: [{
          ...report(1), tool_result: { ...report(1).tool_result, run_id: 'result' },
        }] } },
        entry: { think_scope: main, action_result: { results: [{
          ...entry('resumed').action_result.results[0], tool_result: { ...entry('resumed').action_result.results[0]!.tool_result, run_id: 'result' },
        }] } },
        result: { workflow_result: result },
      }
      const terminalRound = terminalRounds[terminalKind]
      const ended = turn({ id: 'ended', session_ordinal: 1, status: 'completed', agent_state: { think: main }, ota_records: [terminalRound] })
      const messages = paged([exited, ended], 1)
      expect(messages.find((row) => row.id === 'session:u1')!.workflowTurn!.cursor).toBeNull()
    })
  })
  for (const scoped of [false, true]) for (const mainRound of [false, true]) {
    it(`retains the unreported stage when a human reply exits Workflow (scoped=${scoped}, mainRound=${mainRound})`, () => {
      const rounds: Record<string, unknown>[] = [workflowEntry, {
        think_scope: scope, reasoning_content: 'Original stage reasoning', action_result: { results: [{
          tool_name: 'request_human_choice', tool_arguments: { questions: [{ question: 'Which directory?' }] }, tool_result: 'Exit workflow',
        }] },
      }, {
        think_scope: scope, reasoning_content: 'Leaving the stage', action_result: { results: [{
          tool_name: 'switch', success: true, tool_result: { mode: 'normal', stage: null },
        }] },
      }]
      if (mainRound) rounds.push({ think_scope: { mode: 'normal', stage: 'main' }, reasoning_content: 'Main reasoning' })
      const input = turn({ status: 'completed', agent_state: { think: { mode: 'normal', stage: 'main' } },
        ota_records: rounds.map((round) => scoped ? round : Object.fromEntries(Object.entries(round).filter(([key]) => key !== 'think_scope'))),
      })
      const original = structuredClone(input)
      const message = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([input]), { ...run, generation: 'new-gen', executionSteps: ['Unrelated new title'] }))
      expect(headings(message)).toHaveLength(1)
      expect(message.blocks!.slice(1, 6).map((block) => block.type)).toEqual(['workflow_step', 'thinking', 'confirmation', 'thinking', 'build_stage'])
      expect(headings(message)[0]).toMatchObject({ title: 'Choose directory', stepCount: 2, status: 'neutral' })
      if (mainRound) expect(message.blocks!.at(-1)).toEqual({ type: 'thinking', text: 'Main reasoning' })
      expect(input).toEqual(original)
    })
  }
  it('keeps a reported stage successful and closes only the unfinished next stage on exit', () => {
    const message = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([turn({
      status: 'failed', error: 'Later Main failure', agent_state: { think: { mode: 'normal', stage: 'main' } }, ota_records: [
        workflowEntry, { think_scope: scope, reasoning_content: 'First stage', action_result: { results: [report(0)] } },
        { think_scope: scope, reasoning_content: 'Second stage', action_result: { results: [{ tool_name: 'switch', tool_result: { mode: 'normal' } }] } },
        { think_scope: { mode: 'normal', stage: 'main' }, reasoning_content: 'Main failure' },
      ],
    })])))
    expect(headings(message).map(({ title, status }) => [title, status])).toEqual([['Choose directory', 'success'], ['Scan directory', 'neutral']])
    expect(message.blocks!.map((block) => block.type)).toEqual(['thinking', 'workflow_step', 'thinking', 'workflow_step', 'thinking', 'build_stage', 'thinking'])
  })
  it('uses the preceding Turn cursor when an automatically resumed stage exits without a report', () => {
    const before = turn({ status: 'cancelled', agent_state: { think: { ...cursor, step_index: 1 } }, ota_records: [
      workflowEntry, { think_scope: scope, action_result: { results: [report(0)] } },
    ] })
    const after = turn({ id: 'after', session_ordinal: 1, status: 'completed', agent_state: { think: { mode: 'normal', stage: 'main' } }, ota_records: [
      { think_scope: scope, reasoning_content: 'Resumed stage', action_result: { results: [{ tool_name: 'switch', tool_result: { mode: 'normal' } }] } },
    ] })
    const message = resolveWorkflowStepMetadata(sessionTurnsToMessages([before, after])).at(-1)!
    expect(headings(message)[0]).toMatchObject({ generation: 'gen', stepIndex: 1, title: 'Scan directory', status: 'neutral' })
    expect(message.blocks![1]).toEqual({ type: 'thinking', text: 'Resumed stage' })
    const paged = resolveWorkflowStepMetadata([...sessionTurnsToMessages([before]), ...sessionTurnsToMessages([after])]).at(-1)!
    expect(headings(paged)).toEqual(headings(message))
    const missingPage = assistant(sessionTurnsToMessages([after]))
    expect(headings(missingPage)[0]).toMatchObject({ stepIndex: -1, title: '', status: 'neutral' })
    const otherGeneration = turn({ ...before, session_ordinal: -1, agent_state: { think: { ...cursor, generation: 'other' } } })
    const separated = resolveWorkflowStepMetadata([...sessionTurnsToMessages([otherGeneration]), ...sessionTurnsToMessages([after])]).at(-1)!
    expect(headings(separated)[0]).toMatchObject({ stepIndex: -1, title: '' })
  })
  it('does not turn a reported failure neutral when exiting after terminal publication fails', () => {
    const failedReport = report(0)
    const message = assistant(sessionTurnsToMessages([turn({
      status: 'completed', agent_state: { think: { mode: 'normal', stage: 'main' } }, ota_records: [
        workflowEntry,
        { think_scope: scope, action_result: { results: [{ ...failedReport, success: false, tool_result: { ...failedReport.tool_result, status: 'save_failed' } }] } },
        { think_scope: scope, reasoning_content: 'Exit after the failed publication', action_result: { results: [{ tool_name: 'switch', tool_result: { mode: 'normal' } }] } },
      ],
    })]))
    expect(headings(message)).toHaveLength(1)
    expect(headings(message)[0]).toMatchObject({ status: 'failure', title: 'Choose directory' })
  })
  it('keeps two visits to the same stage separate when a Turn exits and resumes before its first report', () => {
    const previous = turn({ status: 'cancelled', ota_records: [workflowEntry] })
    const resumed = turn({ id: 'resumed', session_ordinal: 1, status: 'completed', agent_state: { think: { mode: 'normal', stage: 'main' } }, ota_records: [
      { think_scope: scope, reasoning_content: 'Before exit', action_result: { results: [{ tool_name: 'switch', tool_result: { mode: 'normal' } }] } },
      { think_scope: { mode: 'normal', stage: 'main' }, reasoning_content: 'Main work', action_result: { results: [{
        tool_name: 'request_run_workflow', tool_result: { status: 'resumed', workflow_id: 'wf', workflow_name: 'Directory', execution_steps: run.executionSteps },
      }] } },
      { think_scope: scope, reasoning_content: 'After resume', action_result: { results: [{ ...report(0), tool_result: { ...report(0).tool_result, run_id: 'result' } }] } },
    ] })
    const message = resolveWorkflowStepMetadata(sessionTurnsToMessages([previous, resumed])).at(-1)!
    expect(headings(message).map(({ stepIndex, status }) => [stepIndex, status])).toEqual([[0, 'neutral'], [0, 'success']])
    expect(headings(message)[0]?.historySection).not.toBe(headings(message)[1]?.historySection)
    expect(message.blocks!.map((block) => block.type)).toEqual(['workflow_step', 'thinking', 'build_stage', 'thinking', 'workflow_step', 'thinking'])
  })
  for (const status of ['cancelled', 'failed'] as const) {
    it(`retains entry-only ${status} Turn labels across pages after a new generation starts`, () => {
      const entered = turn({ status, ota_records: [workflowEntry] })
      const resumed = turn({ id: 'resumed', session_ordinal: 1, status: 'cancelled', ota_records: [{ think_scope: scope, reasoning_content: 'First execution OTA' }] })
      const changed = { ...run, generation: 'new', workflowName: 'New workflow', executionSteps: ['New title'] }
      const entryPage = sessionTurnsToMessages([entered])
      expect(headings(assistant(entryPage))).toHaveLength(0)
      expect(entryPage[0]!.workflowMetadata?.[0]).toMatchObject({ generation: 'gen', executionSteps: run.executionSteps })
      const laterPage = resolveWorkflowStepMetadata(sessionTurnsToMessages([resumed]), changed)
      const merged = resolveWorkflowStepMetadata([...entryPage, ...laterPage], changed)
      expect(headings(merged.at(-1)!)[0]).toMatchObject({ generation: 'gen', workflowName: 'Directory', title: 'Choose directory', stepCount: 2, status: 'neutral' })
      expect(headings(resolveWorkflowStepMetadata(sessionTurnsToMessages([entered, resumed]), changed).at(-1)!)).toEqual(headings(merged.at(-1)!))
    })
  }
  it('isolates unreported exits and entry metadata from a later restart in the same Turn', () => {
    const input = turn({ status: 'cancelled', agent_state: { think: { ...cursor, generation: 'new' } }, ota_records: [
      workflowEntry,
      { think_scope: scope, reasoning_content: 'Old stage content', action_result: { results: [{ tool_name: 'switch', tool_result: { mode: 'normal' } }] } },
      { think_scope: { mode: 'normal', stage: 'main' }, reasoning_content: 'Restart from Main', action_result: { results: [{
        tool_name: 'request_run_workflow', tool_result: { status: 'restarted', workflow_id: 'wf', workflow_name: 'Changed workflow', execution_steps: ['New step'] },
      }] } },
      { think_scope: scope, reasoning_content: 'New stage content' },
    ] })
    const message = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([input])))
    expect(headings(message).map(({ title, stepCount }) => [title, stepCount])).toEqual([['Choose directory', 2], ['New step', 1]])
    expect(headings(message)[0]!.generation).not.toBe(headings(message)[1]!.generation)
    expect(message.blocks!.map((block) => block.type)).toEqual(['thinking', 'workflow_step', 'thinking', 'build_stage', 'thinking', 'workflow_step', 'thinking'])
  })
  for (const status of ['cancelled', 'failed'] as const) for (const entryStatus of ['started', 'resumed', 'resolved']) {
    it(`restores ${status} stage labels from the ${entryStatus} entry after a restart`, () => {
      const input = turn({ status, ota_records: [
        { think_scope: { mode: 'normal', stage: 'main' }, action_result: { results: [{
          tool_name: 'request_run_workflow', success: true, tool_result: {
            workflow_id: 'wf', workflow_name: 'Directory', execution_steps: run.executionSteps,
            status: entryStatus, ...(entryStatus === 'resolved' ? { action: 'restart', resolved_action: 'restarted' } : {}),
          },
        }] } },
        { think_scope: scope, reasoning_content: 'Original work before any report' },
      ] })
      const before = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([input]), run))
      const after = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([input]), {
        ...run, generation: 'new-generation', workflowName: 'Edited workflow', executionSteps: ['Changed title'],
      }))
      expect(headings(after)).toEqual(headings(before))
      expect(headings(after)[0]).toMatchObject({ workflowName: 'Directory', title: 'Choose directory', stepCount: 2, generation: 'gen' })
      expect(after.blocks![1]).toEqual({ type: 'thinking', text: 'Original work before any report' })
    })
  }
  it('binds entry labels to their Run segment when one Turn enters multiple generations', () => {
    const entry = (titles: string[], workflowId = 'wf') => ({ think_scope: { mode: 'normal', stage: 'main' }, action_result: { results: [{
      tool_name: 'request_run_workflow', tool_result: { status: 'started', workflow_id: workflowId, workflow_name: titles[0], execution_steps: titles },
    }] } })
    const input = turn({ status: 'cancelled', agent_state: { think: { ...cursor, generation: 'new' } }, ota_records: [
      entry(['Old execution']),
      { think_scope: scope, reasoning_content: 'Old work', action_result: { results: [{
        tool_name: 'report_workflow_step', tool_result: { workflow_id: 'wf', generation: 'gen', step_index: 0, status: 'success', run_id: 'old-result' },
      }] } },
      entry(['New execution', 'New delivery']),
      { think_scope: scope, reasoning_content: 'New work' },
    ] })
    const message = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([input])))
    expect(headings(message).map(({ generation, title, stepCount }) => ({ generation, title, stepCount }))).toEqual([
      { generation: 'gen', title: 'Old execution', stepCount: 1 }, { generation: 'new', title: 'New execution', stepCount: 2 },
    ])
    const differentWorkflow = turn({ ota_records: [entry(['Unrelated'], 'other-workflow'), { think_scope: scope, reasoning_content: 'Work' }] })
    expect(headings(assistant(sessionTurnsToMessages([differentWorkflow])))[0]).toMatchObject({ workflowName: '', title: '', stepCount: 0 })
  })
  it('keeps historical execution and validation labels, counts and contents separate across pages', () => {
    const validation = { ...scope, stage: 'validate' }
    const old = turn({ status: 'cancelled', agent_state: { think: { ...cursor, stage: 'validate' } }, ota_records: [
      { think_scope: scope, reasoning_content: 'Execution content', action_result: { results: [report(0)] } },
      { think_scope: validation, reasoning_content: 'Validation content' },
    ] })
    const later = turn({ id: 'later', session_ordinal: 1, status: 'completed', agent_state: {}, ota_records: [{
      think_scope: validation, action_result: { results: [{ tool_name: 'report_workflow_step', tool_result: {
        workflow_id: 'wf', generation: 'gen', workflow_name: 'Directory', phase: 'validate', step_index: 0,
        title: 'Check result', step_count: 1, execution_steps: run.executionSteps, validation_steps: ['Check result'], status: 'success',
      } }] },
    }] })
    const messages = resolveWorkflowStepMetadata([...sessionTurnsToMessages([old]), ...sessionTurnsToMessages([later])], run)
    expect(headings(assistant(messages)).map(({ phase, title, stepCount, status }) => ({ phase, title, stepCount, status }))).toEqual([
      { phase: 'execute', title: 'Choose directory', stepCount: 2, status: 'success' },
      { phase: 'validate', title: 'Check result', stepCount: 1, status: 'neutral' },
    ])
    expect(assistant(messages).blocks!.map((block) => block.type)).toEqual(['workflow_step', 'thinking', 'workflow_step', 'thinking'])
    const isolated = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([old]), run))
    expect(headings(isolated)[1]).toMatchObject({ phase: 'validate', title: '', stepCount: 0 })
    const completed = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([turn({
      status: 'completed', agent_state: {}, ota_records: [old.ota_records![0]!, { ...later.ota_records![0]!, reasoning_content: 'Validate' }],
    })]), run))
    expect(headings(completed).map((block) => [block.phase, block.title])).toEqual([['execute', 'Choose directory'], ['validate', 'Check result']])
  })
  it('keeps the boundary when duplicate question text before it is removed', () => {
    const message = assistant(sessionTurnsToMessages([turn({ status: 'completed', ota_records: [
      { think_result: { step_content: 'Which directory?' }, action_result: { results: [{ tool_name: 'request_run_workflow', tool_result: { status: 'started' } }] } },
      { think_scope: scope, reasoning_content: 'Ask', action_result: { results: [{ tool_name: 'request_human_choice', tool_arguments: { questions: [{ question: 'Which directory?' }] }, tool_result: '/tmp' }] } },
      { think_scope: scope, action_result: { results: [report(0)] } },
    ] })]))
    expect(message.blocks!.map((block) => block.type)).toEqual(['workflow_step', 'thinking', 'confirmation'])
    expect(headings(message)[0]!.status).toBe('success')
  })
  it('groups multiple Build stages and the return to Main within one Turn', () => {
    const message = assistant(sessionTurnsToMessages([turn({ agent_state: {}, status: 'completed', ota_records: ['main', 'clarify', 'explore', 'main'].map((stage) => ({ think_scope: { mode: stage === 'main' ? 'normal' : 'build', stage }, reasoning_content: stage })) })]))
    expect(message.blocks!.filter((block) => block.type === 'build_stage').map((block) => block.stage)).toEqual(['clarify', 'explore', null])
  })
  it('retains approval criteria, tools, children, user chips and Turn metadata', () => {
    const input = turn({ status: 'awaiting_subagents', user_input: { text: 'Ask', blocks: [{ type: 'mention', id: 'file', label: 'Doc', group: 'file', path: 'doc.md' }] }, ota_records: [{
      think_scope: scope, thinking_blocks: [{ thinking: 'Reasoning' }], act_duration_ms: 50, turn_duration_ms: 200,
      permission: { reviewed: true, items: [{ call_index: 0, tool: 'execute', summary: 'Read folder', sensitive: true, decision: 'allow' }] },
      action_result: { results: [{ tool_name: 'execute', tool_id: 'call', tool_arguments: { cmd: 'ls' }, tool_result: 'files' }, { tool_name: 'run_subagent', tool_id: 'child-call' }] },
    }] })
    const messages = sessionTurnsToMessages([input], { subagents: { 'child-call': [{ session_id: 'child', title: 'Child', turn: turn({ status: 'completed', user_input: { text: 'Review', blocks: [] }, final_answer: 'Reviewed' }) }] } })
    expect(messages[0]!.blocks![0]).toMatchObject({ type: 'mention', path: 'doc.md' })
    const message = assistant(messages)
    expect(message).toMatchObject({ turnId: 'turn', model: 'model', executionMode: 'auto', turnStatus: 'awaiting_subagents', durationMs: 200 })
    expect(message.blocks!.map((block) => block.type)).toEqual(['workflow_step', 'thinking', 'permission', 'tool', 'subagent'])
    expect(message.blocks![2]).toMatchObject({ decided: true, items: [{ callIndex: 0, summary: 'Read folder', sensitive: true, decision: 'allow' }] })
    expect(message.toolCalls[0]).toMatchObject({ toolUseId: 'call', result: { output: 'files', durationMs: 50, isError: false } })
    expect(message.blocks![4]).toMatchObject({ invocationId: 'child', goal: 'Review', status: 'completed', answer: 'Reviewed' })
  })
  it('reads legacy literal questions and workflow review outcomes', () => {
    const message = assistant(sessionTurnsToMessages([turn({ status: 'completed', agent_state: {}, ota_records: [{ action_result: { results: [
      { tool_name: 'request_human_choice', tool_arguments: { prompt: "[{'question': 'Use \\'project\\'?', 'options': []}]" }, tool_result: 'Yes' },
      { tool_name: 'request_human_workflow_confirm', tool_arguments: { prompt: "{'default_name': 'Directory'}" }, tool_result: 'confirmed' },
    ] } }] })]))
    expect(message.blocks![0]).toMatchObject({ type: 'confirmation', question: "Use 'project'?", response: 'Yes' })
    expect(message.blocks![1]).toMatchObject({ type: 'workflow_confirm', defaultName: 'Directory', status: 'confirmed' })
  })
  it('restores an unreported legacy Turn and reads timezone-less durable timestamps as UTC', () => {
    const message = assistant(resolveWorkflowStepMetadata(sessionTurnsToMessages([turn({
      created_at: '2026-09-11T00:00:00', status: 'cancelled', ota_records: [{ reasoning_content: 'Legacy work' }],
    })]), run))
    expect(message.completedAt).toBe(Date.parse('2026-09-11T00:00:00Z'))
    expect(message.blocks![0]).toMatchObject({ type: 'workflow_step', title: 'Choose directory', status: 'neutral' })
    expect(message.blocks![1]).toEqual({ type: 'thinking', text: 'Legacy work' })
  })
  it('shows a pending permission only on the active tail page, using the Session status', async () => {
    const originalFetch = globalThis.fetch
    const input = turn({ status: 'awaiting_permission', agent_state: { think: cursor, interaction: {
      request_id: 'permission', permission: { items: [{ call_index: 0, tool: 'execute' }], questions: [] },
    } }, ota_records: [{ think_scope: scope, reasoning_content: 'Waiting for approval' }] })
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(JSON.stringify({ turns: [input], session_status: 'awaiting' }))) as typeof fetch
    try {
      const client = new AmphiClient({ baseUrl: 'http://localhost:7421', token: null })
      const tail = await client.getSessionMessages('session')
      const older = await client.getSessionMessages('session', { beforeOrdinal: 1 })
      expect(assistant(tail.messages).blocks!.some((block) => block.type === 'permission')).toBe(true)
      expect(assistant(older.messages).blocks!.some((block) => block.type === 'permission')).toBe(false)
    } finally { globalThis.fetch = originalFetch }
  })
  it('projects complete HTTP Turns instead of legacy messages', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
      turns: [turn({ ota_records: [{ think_scope: scope, reasoning_content: 'Own OTA' }] })], messages: [{ id: 'obsolete', text: 'Wrong' }], session_status: 'awaiting',
      workflow_run: { workflow_id: 'wf', generation: 'gen', workflow_name: 'Directory', source_session_id: 'session', phase: 'execute', step_index: 0, execution_steps: run.executionSteps },
    }))
    }) as typeof fetch
    try {
      const result = await new AmphiClient({ baseUrl: 'http://localhost:7421', token: null }).getSessionMessages('session')
      expect(new URL(requestedUrl).searchParams.get('format')).toBe('turns')
      expect(headings(assistant(result.messages))[0]).toMatchObject({ title: 'Choose directory', status: 'running' })
      expect(assistant(result.messages).blocks![1]).toEqual({ type: 'thinking', text: 'Own OTA' })
    } finally { globalThis.fetch = originalFetch }
  })
})
