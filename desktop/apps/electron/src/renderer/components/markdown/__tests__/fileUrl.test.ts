/**
 * fileUrlToTarget tests: parse file:// into local paths, including percent decoding and Windows
 * drive letters, while returning null for non-file or invalid input. This underpins clickable file links.
 */
import { describe, it, expect } from 'bun:test'
import { fileUrlToTarget } from '../fileUrl'

describe('fileUrlToTarget', () => {
  it('POSIX 绝对路径 → path + basename', () => {
    expect(fileUrlToTarget('file:///Users/x/a.txt')).toEqual({
      path: '/Users/x/a.txt',
      name: 'a.txt',
    })
  })

  it('百分号编码解码(空格)', () => {
    expect(fileUrlToTarget('file:///a%20b/c%20d.txt')).toEqual({
      path: '/a b/c d.txt',
      name: 'c d.txt',
    })
  })

  it('Windows 盘符去前导斜杠', () => {
    expect(fileUrlToTarget('file:///C:/Users/x/a.txt')).toEqual({
      path: 'C:/Users/x/a.txt',
      name: 'a.txt',
    })
  })

  it('保留 UNC 主机名并恢复 Windows 网络路径', () => {
    expect(fileUrlToTarget('file://fileserver/team/My%20Report.pdf')).toEqual({
      path: '\\\\fileserver\\team\\My Report.pdf',
      name: 'My Report.pdf',
    })
  })

  it('接受标准允许的单斜杠 file URL', () => {
    expect(fileUrlToTarget('file:/tmp/result.png')).toEqual({
      path: '/tmp/result.png',
      name: 'result.png',
    })
  })

  it('非 file: 协议 → null', () => {
    expect(fileUrlToTarget('https://example.com/a.txt')).toBeNull()
    expect(fileUrlToTarget('mailto:x@y.com')).toBeNull()
  })

  it('非法 URL / 无协议路径 → null', () => {
    expect(fileUrlToTarget('not a url')).toBeNull()
    expect(fileUrlToTarget('/Users/x/a.txt')).toBeNull()
  })
})
