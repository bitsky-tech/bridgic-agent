/**
 * ModalBackdrop 的五条不变式 —— 全都是「看起来没问题、坏了也很难一眼看出」的那种。
 *
 * 背景:遮罩逻辑此前散在 Modal / SettingsModal / RunLogDrawer 三处各写一遍,修
 * Windows caption 遮挡时漏掉了 SettingsModal(它用 `absolute` 而非 `fixed`,搜索
 * 都没命中),用户实测才发现。收敛成一个组件后,这里把不变式钉死,免得下次又靠
 * 肉眼发现。
 *
 * 特别是「点击遮罩空白处关闭」:它依赖背景层的 `pointer-events-none` —— 少了这个
 * 类,点击目标会变成背景层本身,`e.target === e.currentTarget` 判定失效,弹窗就
 * 关不掉了。纯视觉检查看不出这种差别(遮罩长得一模一样)。
 *
 * 第五条(按下与松开必须都落在遮罩上)同理:改回只听 click 的话,日常点击行为一切
 * 正常,只有"从面板里往外拖再松手"才会露馅 —— 而这恰恰是抽屉拖宽度的标准手势。
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ModalBackdrop } = await import('../ModalBackdrop')

/** 挂载到一个**独立**容器,好证明遮罩确实 portal 到了 body 而不是留在原地。 */
async function mount(ui: React.ReactElement): Promise<{ host: HTMLDivElement; cleanup: () => Promise<void> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return {
    host,
    cleanup: async () => {
      await act(async () => { root.unmount() })
      host.remove()
    },
  }
}

const backdropOf = (): HTMLElement => {
  const el = document.querySelector('[data-testid="bd"]')
  if (!el) throw new Error('backdrop not rendered')
  return el as HTMLElement
}

const cardOf = (): HTMLElement => document.querySelector('[data-testid="card"]') as HTMLElement

/** 走完一次真实的鼠标手势:按下 → 松开(可以落在不同元素上,模拟拖拽)。 */
async function press(from: HTMLElement, to: HTMLElement = from, button = 0): Promise<void> {
  await act(async () => {
    from.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button }))
    to.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button }))
  })
}

describe('ModalBackdrop', () => {
  it('portals out of the mount container into body', async () => {
    const { host, cleanup } = await mount(
      <ModalBackdrop data-testid="bd"><span data-testid="card">x</span></ModalBackdrop>,
    )
    // 留在原地的话,从 composer 之类的定位祖先里打开就会"看起来没有蒙层"
    // —— 这正是 SettingsModal 改造前的老毛病。
    expect(host.querySelector('[data-testid="bd"]')).toBeNull()
    expect(backdropOf().parentElement).toBe(document.body)
    await cleanup()
  })

  it('closes when the dim area itself is clicked', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    await press(backdropOf())
    expect(closed).toBe(1)
    await cleanup()
  })

  it('does NOT close when the content is clicked', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    await press(cardOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('does NOT close when a drag starts inside the content and ends on the dim area', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    // 抽屉左沿拖宽度、或在弹窗里选中文字拖过头,都是这个手势。原生 `click` 会派发到
    // 按下/松开两个目标的最近公共祖先 = 遮罩容器本身,只看 click 的话正好误判成
    // "点了空白处" → 拖个宽度就把抽屉关了。
    await press(cardOf(), backdropOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('does NOT close when a drag starts on the dim area and ends inside the content', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    await press(backdropOf(), cardOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('does NOT close on a non-primary button press', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    // 只听 click 时右键天然不触发(非主键走 auxclick);换成 mousedown/mouseup 后就必须
    // 自己滤 —— 否则在暗区右键(想粘贴却点偏)会直接关掉弹层。
    await press(backdropOf(), backdropOf(), 2)
    await press(backdropOf(), backdropOf(), 1)
    expect(closed).toBe(0)
    await press(backdropOf())
    expect(closed).toBe(1)
    await cleanup()
  })

  it('does not leak the press origin into the next gesture', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    // 上一次手势起点在遮罩上但没落成关闭;若不复位标记,下一次从内容里松开到遮罩
    // 就会被上一次的起点"续命"。
    await press(backdropOf(), cardOf())
    await press(cardOf(), backdropOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('keeps the dim layer click-through and below the content', async () => {
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd"><span>x</span></ModalBackdrop>,
    )
    const dim = backdropOf().querySelector('div')
    expect(dim).not.toBeNull()
    const cls = dim!.className
    // pointer-events-none:没有它,上面那条"点内容不关闭"会反过来失效
    // (点击目标变成本层,与 currentTarget 不等 → 反而永远关不掉)。
    expect(cls).toContain('pointer-events-none')
    // -z-10:落到内容之下。用负 z 而不是给内容加 relative —— 那会改变内容内部
    // absolute 子元素的定位基准。
    expect(cls).toContain('-z-10')
    await cleanup()
  })

  it('starts the whole overlay — container, not just the dim layer — below the Windows caption strip', async () => {
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd"><span>x</span></ModalBackdrop>,
    )
    // caption 三按钮由系统合成在 WebContents 之上,z-index 盖不住。让位必须做在
    // **容器**上:只压暗色层的话,贴顶的内容(抽屉 `h-full`)照样把自己的按钮送到
    // 系统三按钮底下 —— RunLogDrawer 就这么漏了一轮。非 win32 该变量恒为 0。
    expect(backdropOf().className).toContain('top-[var(--titlebar-win-inset-top)]')
    // 容器已让位,暗色层铺满容器即可;它若还带自己的 top 偏移就是让位做了两遍。
    expect(backdropOf().querySelector('div')!.className).toContain('inset-0')
    await cleanup()
  })
})
