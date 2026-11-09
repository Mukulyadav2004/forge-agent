import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Frame } from 'playwright-core';

export async function checkSidebarLayout(options: { frame: Frame; extensionUri: vscode.Uri }): Promise<void> {
  const { frame } = options;
  const original = await frame.locator('body').getAttribute('style');
  const rootStyle = await frame.locator('html').getAttribute('style');
  const font = await frame.evaluate(() => ({ root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize), body: Number.parseFloat(getComputedStyle(document.body).fontSize) }));
  try {
    for (const fixture of [
      { name: 'normal', width: 360, height: 720, scale: 1 },
      { name: 'narrow-short', width: 240, height: 480, scale: 1 },
      { name: 'large-text', width: 360, height: 600, scale: 1.5 },
    ]) {
      await frame.evaluate(size => {
        document.body.style.width = `${Math.min(size.width, window.innerWidth)}px`;
        document.body.style.height = `${Math.min(size.height, window.innerHeight)}px`;
        document.documentElement.style.fontSize = `${size.font.root * size.scale}px`;
        document.body.style.setProperty('--vscode-font-size', `${size.font.body * size.scale}px`);
        document.querySelector('#task-content')?.scrollTo(0, 0);
        document.querySelector('.proposal-list')?.scrollTo(0, 0);
      }, { ...fixture, font });
      const metrics = await frame.evaluate(() => {
        function box(selector: string) {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, width: rect.width };
        }
        const undo = [...document.querySelectorAll('#review-panel > .review-actions button')].find(button => button.textContent === 'Undo last apply');
        if (!(undo instanceof HTMLButtonElement)) throw new Error('Missing Undo button');
        const rect = undo.getBoundingClientRect();
        return {
          body: box('body'), header: box('header'), task: box('#task-content'), review: box('#review-panel'),
          composer: box('#message-form'), input: box('#message-input'), list: box('.proposal-list'),
          undo: { top: rect.top, bottom: rect.bottom, right: rect.right, disabled: undo.disabled },
          documentWidth: document.documentElement.clientWidth,
        };
      });
      await frame.locator('body').screenshot({ path: vscode.Uri.joinPath(options.extensionUri, 'out-test', `sidebar-layout-${fixture.name}.png`).fsPath });
      assert.ok(metrics.header.height < metrics.body.height * 0.3, `${fixture.name}: setup dominates the panel: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.task.height >= metrics.body.height * 0.3, `${fixture.name}: task area is squeezed`);
      assert.ok(metrics.input.height > 0 && metrics.composer.bottom <= metrics.body.bottom + 1, `${fixture.name}: composer clipped`);
      assert.ok(metrics.review.height >= 190 * fixture.scale, `${fixture.name}: review collapsed`);
      assert.ok(metrics.undo.top >= metrics.task.top && metrics.undo.bottom <= metrics.task.bottom + 1, `${fixture.name}: Undo clipped: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.undo.right <= metrics.body.right + 1 && metrics.body.right <= metrics.documentWidth + 1, `${fixture.name}: horizontal overflow`);
      assert.equal(metrics.undo.disabled, false);
      const toolbarBefore = await frame.locator('#review-panel > .review-actions').boundingBox();
      assert.ok(toolbarBefore);
      await frame.locator('.proposal-list').evaluate(element => element.scrollTo(0, element.scrollHeight));
      const toolbarAfter = await frame.locator('#review-panel > .review-actions').boundingBox();
      assert.ok(toolbarAfter);
      assert.ok(Math.abs(toolbarAfter.y - toolbarBefore.y) < 1, `${fixture.name}: review actions scrolled away`);
      await frame.locator('body').screenshot({ path: vscode.Uri.joinPath(options.extensionUri, 'out-test', `sidebar-layout-${fixture.name}.png`).fsPath });
    }
  } finally {
    await frame.locator('html').evaluate((element, style) => {
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
    }, rootStyle);
    await frame.locator('body').evaluate((element, style) => {
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
      document.querySelector('#task-content')?.scrollTo(0, 0);
      document.querySelector('.proposal-list')?.scrollTo(0, 0);
    }, original);
  }
}
