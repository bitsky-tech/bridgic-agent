import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PromptReadableView,
  buildReadableFidelityGroups,
  readableFidelity,
  type PromptReadableBlock,
} from './PromptReadableView'

const blocks: PromptReadableBlock[] = [
  {
    id: 'persona',
    label: 'Main persona',
    text: 'Line one\nLine two\nDo not truncate this final line.',
    fidelity: 'exact',
    sources: ['pinned persona source'],
    badges: [{ label: 'Summary applied', tone: 'info' }],
    defaultExpanded: true,
  },
  {
    id: 'context',
    label: 'Runtime context',
    text: '<Workspace>\n/tmp/session\n</Workspace>',
    fidelity: 'partial',
    limitations: ['Historical browser tabs were not persisted.'],
  },
  {
    id: 'memory',
    label: 'Recalled memory',
    text: '',
    fidelity: 'unavailable',
  },
]

describe('PromptReadableView', () => {
  test('maps partial fidelity into the user-facing reconstructed group', () => {
    const groups = buildReadableFidelityGroups(blocks, [{
      id: 'live-files',
      status: 'reconstructed',
      title: 'Workspace files use their current contents',
    }])

    expect(readableFidelity('partial')).toBe('reconstructed')
    expect(groups.exact.map((item) => item.title)).toEqual(['Main persona'])
    expect(groups.reconstructed.map((item) => item.title)).toEqual([
      'Runtime context',
      'Workspace files use their current contents',
    ])
    expect(groups.unavailable.map((item) => item.title)).toEqual(['Recalled memory'])
  })

  test('renders full block text, chat messages, and structured tool arguments without JSON blobs', () => {
    const markup = renderToStaticMarkup(
      <PromptReadableView
        blocks={blocks}
        messages={[
          { id: 'system', role: 'system', content: 'System message' },
          {
            id: 'assistant',
            role: 'assistant',
            content: 'I will inspect the file.',
            toolCalls: [{
              id: 'call_1',
              name: 'read_file',
              arguments: { path: '/tmp/session/a.md', options: { encoding: 'utf-8' } },
            }],
          },
          { id: 'tool', role: 'tool', content: 'File contents', toolCallId: 'call_1' },
        ]}
      />,
    )

    expect(markup).toContain('<details')
    expect(markup).toContain('Do not truncate this final line.')
    expect(markup).toContain('class="prompt-block-badge is-info">Summary applied</span>')
    expect(markup).toContain('prompt-message-assistant')
    expect(markup).toContain('read_file')
    expect(markup).toContain('/tmp/session/a.md')
    expect(markup).toContain('<dt>encoding</dt>')
    expect(markup).not.toContain('&quot;path&quot;')
  })

  test('shows copy controls only when a copy handler is supplied and accepts Chinese labels', () => {
    const withoutCopy = renderToStaticMarkup(
      <PromptReadableView blocks={blocks} messages={[]} labels={{ copy: '复制' }} />,
    )
    const withCopy = renderToStaticMarkup(
      <PromptReadableView
        blocks={blocks}
        messages={[]}
        labels={{ blocks: '提示词区块', copy: '复制', copied: '已复制' }}
        copyText={() => undefined}
      />,
    )

    expect(withoutCopy).not.toContain('prompt-copy-button')
    expect(withCopy).toContain('提示词区块')
    expect(withCopy).toContain('>复制</button>')
  })

  test('can hide reconstruction coverage, fidelity badges, and block caveats', () => {
    const markup = renderToStaticMarkup(
      <PromptReadableView
        blocks={blocks}
        messages={[]}
        showFidelity={false}
        showLimitations={false}
      />,
    )

    expect(markup).not.toContain('Reconstruction coverage')
    expect(markup).not.toContain('prompt-readable-fidelity')
    expect(markup).not.toContain('prompt-fidelity-badge')
    expect(markup).not.toContain('Historical browser tabs were not persisted.')
    expect(markup).toContain('pinned persona source')
    expect(markup).toContain('Runtime context')
  })

  test('can start with every assembly block collapsed', () => {
    const markup = renderToStaticMarkup(
      <PromptReadableView
        blocks={blocks}
        messages={[]}
        defaultExpandedBlockIds={[]}
      />,
    )

    expect(markup).not.toContain(' open=""')
  })

  test('allows a block to replace the default preformatted body', () => {
    const markup = renderToStaticMarkup(
      <PromptReadableView
        blocks={blocks}
        messages={[]}
        renderBlockContent={(block) => block.id === 'context'
          ? <div data-testid="structured-context">Structured context</div>
          : undefined}
      />,
    )

    expect(markup).toContain('data-testid="structured-context"')
    expect(markup).toContain('Structured context')
    expect(markup).toContain('Do not truncate this final line.')
    expect(markup).not.toContain('&lt;Workspace&gt;')
  })
})
