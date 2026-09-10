import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n'
import { ExperimentWorkbench } from './ExperimentWorkbench'
import { getDemoScenarios } from './demo-data'
import { PresentationInteractionContent } from './PresentationInteractionContent'
import { createExperimentPreviewState, type ExperimentSession } from './experiment-state'
import { getPresentationHighlights } from './presentation-highlights'
import { getPresentationTrace, type PresentationTrace } from './presentation-trace-data'

const noop = () => {}
const initial = createExperimentPreviewState().modes.find(mode => mode.id === 'presentation')!.sessions[0]!
const render = (trace: PresentationTrace | null, session: ExperimentSession | undefined) => renderToStaticMarkup(
  <I18nProvider initialLocale="en-US">
    <ExperimentWorkbench session={session} modeId="presentation" modeLabel="PPT orchestration" scenario={getDemoScenarios('en-US')[0]!} onInspectStage={noop} trace={trace} onInspectRound={noop}>
      {({ onArtifact, records }) => <article aria-label="Execution tree"><p>Current execution content</p><button onClick={() => onArtifact('brief')}>Inspect the brief</button><span data-call-count={records.calls.length} /></article>}
    </ExperimentWorkbench>
  </I18nProvider>,
)

describe('experiment workbench', () => {
  test('connects a tool debugger beside the conversation with selected-only rail emphasis', async () => {
    const html = render(getPresentationTrace('en-US'), initial)
    const tabs: Array<{surface:string|null;selected:string|null;state:string|null}> = []
    await new HTMLRewriter().on('.experiment-rail-button', {element: el => {
      tabs.push({surface:el.getAttribute('data-surface'),selected:el.getAttribute('aria-selected'),state:el.getAttribute('data-state')})
    }}).transform(new Response(html)).text()
    expect(tabs).toEqual([
      {surface:'agent',selected:'false',state:'background-open'},
      {surface:'tools',selected:'true',state:'active'},
      {surface:'rounds',selected:'false',state:'background-open'},
    ])
    expect(html).toContain('Current execution content')
    expect(html).toContain('data-call-count="17"')
    expect(html).toContain('experiment-rail-tab-tools')
    expect(html).toContain('request_human_choice')
    expect(html).not.toContain('experiment-rail-tab-interactions')
    expect(html).not.toContain('experiment-rail-tab-stages')
    expect(html).not.toMatch(/<dialog|aria-modal="true"/)
  })

  test('new tests do not borrow the fixture records', () => {
    const session:ExperimentSession = {id:'new',input:'Astronomy',draft:'',createdAt:0,completedStages:0,status:'running',turns:[{id:'new-turn',input:'Astronomy',startedAt:0,status:'running',startStageIndex:0,completedStages:0,continuation:'initial'}]}
    for (const current of [undefined,session]) {
      const html=render(null,current)
      expect(html).toContain('data-call-count="0"')
      expect(html).toContain('data-panel-open="false"')
      expect(html).not.toContain('Buddhis')
      expect(html).not.toContain('request_presentation')
    }
  })

  test('continuing a fixture retains its original calls without creating unfinished calls', () => {
    const continued:ExperimentSession = {...initial,status:'cancelled',turns:[...initial.turns,{id:'followup',input:'Use more examples',startedAt:1,status:'cancelled',startStageIndex:0,completedStages:0,continuation:'reassess'}]}
    const html=render(getPresentationTrace('en-US'),continued)
    expect(html).toContain('data-call-count="17"')
    expect(html).toContain('Use more examples')
    expect(initial.turns).toHaveLength(1)
    expect(initial.status).toBe('awaiting')
  })

  test('replays generic choices and recorded answers separately from the stage-specific outline request', async () => {
    const { interactions } = getPresentationHighlights(getPresentationTrace('en-US'), 'en-US')
    const renderInteraction = (kind: 'human-choice' | 'presentation-outline') => renderToStaticMarkup(
      <I18nProvider initialLocale="en-US"><PresentationInteractionContent interaction={interactions.find(item => item.kind === kind)!} onInspectRound={noop} onOutline={noop} /></I18nProvider>,
    )
    const choice = renderInteraction('human-choice')
    const answers: string[] = []
    const selectedOptions: string[] = []
    await new HTMLRewriter()
      .on('.run-recorded-answer strong', {
        element: () => { answers.push('') },
        text: chunk => { answers[answers.length - 1] += chunk.text },
      })
      .on('.run-question-options .is-chosen', {
        element: () => { selectedOptions.push('') },
        text: chunk => { selectedOptions[selectedOptions.length - 1] += chunk.text },
      })
      .transform(new Response(choice)).text()
    expect(choice).toContain('Who is this presentation for?')
    expect(choice).toContain('How will this presentation be used?')
    expect(choice).toContain('Adults')
    expect(choice).toContain('Classroom presentation')
    expect(answers).toEqual(['Secondary school students', 'Self-paced reading'])
    expect(selectedOptions).toEqual(answers)
    expect(choice).not.toContain('awaiting outline approval')

    const outline = renderInteraction('presentation-outline')
    expect(outline).toContain('Stage-specific')
    expect(outline).toContain('PPT orchestration · Plan slides')
    expect(outline).toContain('4 chapters · 11 slides')
    expect(outline).toContain('View slide outline')
    expect(outline).toContain('No response yet · awaiting outline approval')
    expect(outline).not.toContain('Recorded answer')
    for (const html of [choice, outline]) {
      expect(html).toContain('replay only, no response is submitted')
      expect(html).toContain('Inspect execution record')
      expect(html).not.toMatch(/<dialog|role="dialog"|aria-modal="true"/)
    }
  })

})
