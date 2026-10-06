import { module, test } from 'qunit';
import { setupRenderingTest } from 'ember-qunit';
import { render, click, fillIn } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';

function buttonWithText(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.trim().includes(text),
  );
}

function cueRowWithText(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.cue-row')].find((row) =>
    row.textContent?.includes(text),
  );
}

module('Integration | Component | cue-editor', function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    localStorage.clear();
  });

  test('锚点阻断：预演列出保留原因，应用失败回滚且原因保留', async function (assert) {
    await render(hbs`<CueEditor />`);
    await click(cueRowWithText('古琴引子淡入')!);
    await fillIn('.reschedule-box input', '180');
    await click(buttonWithText('预演重排')!);

    assert.dom('.preview-panel').exists('预演面板打开');
    assert.dom('.preview-section.is-blocked').includesText('固定锚点');
    assert.dom('.preview-section.is-blocked').includesText('保持 19:34:15');
    assert.dom('.preview-status').includesText('阻塞');

    await click(buttonWithText('只移动冲突项')!);
    assert
      .dom('.preview-section.is-blocked')
      .includesText('固定锚点', '切换策略后锚点仍然阻断');

    await click(buttonWithText('应用重排')!);
    assert.dom('.preview-failure').exists('应用失败提示保留在面板中');
    assert
      .dom('.preview-section.is-blocked')
      .includesText('固定锚点', '冲突原因仍然保留');
    assert
      .dom(
        cueRowWithText('月牙灯升至舞台中线')!.querySelector('.cue-time strong'),
      )
      .hasText('19:34:15', '改前状态已恢复，锚点提示时间未变');
  });

  test('确认重排：应用成功并写入排练修订', async function (assert) {
    await render(hbs`<CueEditor />`);
    await click(cueRowWithText('说书人掷扇收篇')!);
    await fillIn('.reschedule-box input', '90');
    await click(buttonWithText('预演重排')!);

    assert.dom('.preview-status').hasText('方案可应用');
    await click(buttonWithText('应用重排')!);

    assert.dom('.preview-panel').doesNotExist('应用成功后预演面板关闭');
    assert.dom('.revision-item').exists({ count: 1 }, '排练修订已写入');
    assert.dom('.revision-item').includesText('说书人掷扇收篇');
    assert.dom('.revision-item').includesText('30 → 90 秒');
    assert.dom('.revision-item').includesText('顺延整段');
  });

  test('已移除提示仍被引用时给出待处理标记', async function (assert) {
    await render(hbs`<CueEditor />`);
    const row = cueRowWithText('古琴引子淡入')!;
    assert.dom(row.querySelector('.pending-flag')).hasText('待处理');
    assert.dom('.issue-item').includesText('待处理 · 引用的提示已删除');
  });
});
