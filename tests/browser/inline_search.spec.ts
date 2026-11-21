import { test, expect } from 'playwright/test'
declare const renderingUnderTest: typeof import('../../src/index')
declare const searchAudit: any

for (const setup of [{ width: 900, dark: false }, { width: 640, dark: false }, { width: 900, dark: true }]) {
  test(`inline search across five selectors (${setup.width}px ${setup.dark ? 'dark' : 'light'})`, async ({ page }, info) => {
    await page.setViewportSize({ width: setup.width, height: 650 })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto('/')
    await page.waitForFunction(() => !!(window as any).renderingUnderTest)
    await page.evaluate(({ width, dark }) => {
      const a = renderingUnderTest
      document.body.innerHTML = '<canvas id="app" style="position:fixed;inset:0;width:100%;height:100%"></canvas>'
      const root = new a.RenderStackPanel({ padding: 20, spacing: 16, crossAxisAlignment: 'stretch' })
      const leaves = [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]
      const roots = [{ key: 'group', label: 'Group', children: leaves }]
      const fields: any[] = [
        new a.RenderLookupEdit({ columns: [{ key: 'name', title: 'Name' }], rows: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], valueKey: 'id', labelKey: 'name', searchable: true, clearable: true }),
        new a.RenderComboBox({ options: leaves.map(n => ({ value: n.key, label: n.label })), searchable: true, clearable: true }),
        new a.RenderDropTreeEdit({ roots, searchable: true, clearable: true }),
        new a.RenderDropTreeGridEdit({ columns: [{ key: 'name', title: 'Name', width: 200 }], roots: [{ key: 'group', row: { name: 'Group' }, selectable: false, children: leaves.map(n => ({ key: n.key, row: { name: n.label } })) }], treeColumnKey: 'name', labelKey: 'name', searchable: true, clearable: true }),
        new a.RenderDropCheckTreeEdit({ roots, checkedKeys: ['a'], searchable: true, clearable: true }),
      ]
      const labels = ['Lookup', 'ComboBox', 'Tree', 'Tree grid', 'Check tree']
      fields.forEach((field, i) => { field.width = width === 640 ? 180 : 300; root.addChild(new a.RenderFormField({ label: labels[i], labelWidth: 100, child: field })) })
      const main = new a.RenderWindow({ title: 'Inline search', chrome: 'none', width, height: 650 })
      main.addChild(root)
      const host = a.Application.mount('#app').run(main, { theme: dark ? a.ImGuiDarkTheme : a.ModernCompactLightTheme })
      ;(window as any).searchAudit = { fields, main, host, other: null, events: [] }
      main.addKeyboardEventListener('keydown', e => searchAudit.events.push(`main:${e.key}`), { capture: true })
    }, setup)
    await page.waitForTimeout(100)
    for (let index = 0; index < 5; index++) {
      await page.evaluate(index => { searchAudit.field = searchAudit.fields[index] }, index)
      const position = () => page.evaluate(() => ({ x: searchAudit.field.globalOffset.x + 12, y: searchAudit.field.globalOffset.y + 13 }))
      let p = await position(); await page.mouse.click(p.x, p.y)
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('Beta')
      expect(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value)).toBe('Beta')
      expect(await page.evaluate(() => searchAudit.field._popup.visible)).toBe(true)
      expect(await page.evaluate(() => searchAudit.field._popup._searchable ?? false)).toBe(false)
      if (index < 2) { await page.keyboard.press('Enter'); expect(await page.evaluate(() => searchAudit.field.getValue())).toBe('b'); p = await position(); await page.mouse.click(p.x, p.y); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('Beta') }
      else { await page.keyboard.press('Enter'); expect(await page.evaluate(() => searchAudit.field.getValue())).toEqual(index === 4 ? ['a'] : '') }
      for (let n = 0; n < (index < 2 ? 1 : 2); n++) await page.keyboard.press('ArrowDown')
      await page.screenshot({ path: info.outputPath(`selector-${index}-search.png`) })
      await page.keyboard.press('Enter')
      const selected = await page.evaluate(() => searchAudit.field.getValue())
      expect(selected).toEqual(index === 4 ? ['a', 'b'] : 'b')
      expect(await page.evaluate(() => searchAudit.field._focused)).toBe(true)
      p = await position(); await page.mouse.click(p.x, p.y)
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('no-match')
      await page.keyboard.press('Enter'); expect(await page.evaluate(() => searchAudit.field.getValue())).toEqual(selected)
      await page.keyboard.press('Escape'); expect(await page.evaluate(() => searchAudit.field._popup.visible)).toBe(false)
      p = await position(); await page.mouse.click(p.x, p.y)
      await page.evaluate(() => { searchAudit.old = document.activeElement; searchAudit.old.dispatchEvent(new CompositionEvent('compositionstart')); searchAudit.old.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'pending' })) })
      await page.keyboard.press('Enter'); expect(await page.evaluate(() => searchAudit.field.getValue())).toEqual(selected)
      await page.evaluate(() => { searchAudit.field.disabled = true; searchAudit.field.disabled = false; searchAudit.old.value = 'late'; searchAudit.old.dispatchEvent(new CompositionEvent('compositionend', { data: 'late' })); searchAudit.old.dispatchEvent(new Event('input')) })
      expect(await page.evaluate(() => searchAudit.field._popup.visible)).toBe(false)
      expect(await page.evaluate(() => searchAudit.field.getValue())).toEqual(selected)
      p = await position(); await page.mouse.click(p.x, p.y)
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => searchAudit.field._popup.visible)).toBe(false)
      const clear = await page.evaluate(() => { const r = searchAudit.field._triggerLayout().clearRect; return { x: r.x + r.w / 2, y: r.y + r.h / 2 } })
      await page.mouse.click(clear.x, clear.y)
      expect(await page.evaluate(() => searchAudit.field.getValue())).toEqual(index === 4 ? [] : '')
    }
    // A different window must receive its own native typing without mutating selectors.
    await page.evaluate(() => {
      const a = renderingUnderTest
      const other = new a.RenderWindow({ title: 'Other window', x: 230, y: 40, width: 320, height: 180 })
      const input = new a.RenderTextBox({ value: '' })
      other.addChild(input); searchAudit.host.uiServices.showWindow(other)
      other.addKeyboardEventListener('keydown', e => searchAudit.events.push(`other:${e.key}`), { capture: true })
      searchAudit.other = { window: other, input }
      searchAudit.events = []; input.requestFocus()
    })
    await page.keyboard.type('isolated')
    expect(await page.evaluate(() => searchAudit.other.input.value)).toBe('isolated')
    expect(await page.evaluate(() => searchAudit.events.some((x: string) => x.startsWith('main:')))).toBe(false)
    expect(await page.evaluate(() => searchAudit.fields.map((f: any) => f.getValue()))).toEqual(['', '', '', '', []])
    expect(errors).toEqual([])
    await page.evaluate(() => searchAudit.host.dispose())
  })
}
