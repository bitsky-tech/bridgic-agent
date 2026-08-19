import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from './App'

describe('Bridgic Agent Lab shell', () => {
  test('renders the English platform modules and default Agent Loop workspace', () => {
    const html = renderToStaticMarkup(<App initialLocale="en-US" />)

    expect(html).toContain('Bridgic Agent Lab')
    expect(html).toContain('Agent Loop Lab')
    expect(html).toContain('File Import Lab')
    expect(html).toContain('Memory Lab')
    expect(html).toContain('Local state.db')
    expect(html).toContain('Loading sessions')
    expect(html).toContain('Loading local trace data')
  })

  test('renders the Chinese interface while the local database is loading', () => {
    const html = renderToStaticMarkup(<App initialLocale="zh-CN" />)

    expect(html).toContain('本地工程工作台')
    expect(html).toContain('Agent 循环实验室')
    expect(html).toContain('文件导入实验室')
    expect(html).toContain('本地 state.db')
    expect(html).toContain('正在加载会话')
    expect(html).toContain('正在读取本地 Trace 数据')
  })
})
