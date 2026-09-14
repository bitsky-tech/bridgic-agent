import { describe, expect, it } from 'bun:test'
import { createModelRequestDraft, inspectModelRequest, replaceRequestOtherFields, requestOtherFields, setRequestValue, startManualModelRequest } from './model-request-draft'

describe('recorded model request drafts', () => {
  it('finds nested requests without flattening messages, native blocks or provider options', () => {
    const nativeBlocks = [{ type: 'text', text: '  Keep spaces\n' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }]
    const request = { llm_request: { payload: { model: 'captured', messages: [
      { role: 'system', content: 'Original instructions' },
      { role: 'assistant', content: nativeBlocks, tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a"}' } }], provider_metadata: { signature: 'test-signature' } },
    ], temperature: 0, provider: { reasoning: { effort: 'high' } }, tools: [{ type: 'function', function: { name: 'read' } }] }, request_id: 'saved-id' }, model_options: { max_tokens: 4096, cache: false } }
    const draft = createModelRequestDraft(request)
    const parsed = inspectModelRequest(draft.request)
    expect(parsed.hasPrompt).toBe(true)
    expect(parsed.primary.path).toEqual(['llm_request', 'payload'])
    expect(parsed.messages[0]?.path).toEqual(['llm_request', 'payload', 'messages'])
    expect(parsed.models[0]?.value).toBe('captured')
    expect(parsed.tools[0]?.value).toEqual(request.llm_request.payload.tools)
    const changed = setRequestValue(draft.request, ['llm_request', 'payload', 'messages', 0, 'content'], 'Edited instructions')
    expect(changed).toEqual({ ...request, llm_request: { ...request.llm_request, payload: { ...request.llm_request.payload,
      messages: [{ role: 'system', content: 'Edited instructions' }, request.llm_request.payload.messages[1]],
    } } })
    expect(draft.original).toEqual(request)
    expect(draft.original).not.toBe(request)
    expect(request.llm_request.payload.messages[0]?.content).toBe('Original instructions')
  })

  it('keeps parallel snapshots and explicit empty values in their original fields', () => {
    const request = { request: { request_messages: [{ role: 'user', content: '' }] }, prompt_messages: [], system_prompt: '', prompt: '  Plain prompt\n', tool_definitions: null, model_options: { temperature: 0, stop: [] } }
    const parsed = inspectModelRequest(request)
    expect(parsed.messages.map((field) => field.path)).toEqual([['prompt_messages'], ['request', 'request_messages']])
    expect(parsed.prompts.map((field) => field.value)).toEqual(['', '  Plain prompt\n'])
    expect(parsed.tools[0]?.value).toBeNull()
    expect(createModelRequestDraft(request).request).toEqual(request)
  })

  it('edits parameter fields without dropping separate model, tool, prompt or nested provider fields', () => {
    const request = { request: { model: 'm', messages: [], tools: [], temperature: 0, vendor: { opaque: [false, null] }, model_options: { response_format: { type: 'json_object' } } } }
    expect(requestOtherFields(request.request)).toEqual({ temperature: 0, vendor: { opaque: [false, null] } })
    const changed = replaceRequestOtherFields(request, ['request'], { temperature: 0.5, vendor: { opaque: [false, null] }, top_p: 0.9 })
    expect(changed).toEqual({ request: { ...request.request, temperature: 0.5, top_p: 0.9 } })
    expect(() => replaceRequestOtherFields(request, ['request'], { messages: ['bad'] })).toThrow()
    expect(() => replaceRequestOtherFields(request, ['request'], [])).toThrow()
  })

  it('requires an explicit manual draft when prompt data is missing, keeping historical malformed fields intact', () => {
    const historical = { request: { messages: null, request_messages: false, prompt_messages: 12, vendor_option: true }, prompt: null }
    const draft = createModelRequestDraft(historical)
    expect(inspectModelRequest(draft.request).hasPrompt).toBe(false)
    expect(draft.manual).toBe(false)
    const manual = startManualModelRequest(draft)
    expect(manual.manual).toBe(true)
    expect(manual.original).toEqual(historical)
    expect(manual.request).toEqual({ ...historical, debug_request: { messages: [{ role: 'user', content: '' }] } })
    expect(inspectModelRequest(manual.request).hasPrompt).toBe(true)
  })

  it('preserves literal JSON keys without changing object prototypes', () => {
    const original = JSON.parse('{"request":{"messages":[],"__proto__":{"keep":true}}}')
    const changed = setRequestValue(original, ['request', '__proto__', 'keep'], false)
    expect(JSON.stringify(changed)).toBe('{"request":{"messages":[],"__proto__":{"keep":false}}}')
    expect(Object.getPrototypeOf(changed.request)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).keep).toBeUndefined()
  })
})
