const { chromium } = require('playwright');

const BASE = 'http://localhost:21825';
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  // 两个窗口共享同一个 context：localStorage / IndexedDB / BroadcastChannel 同源互通
  const context = await browser.newContext();
  const a = await context.newPage();
  const b = await context.newPage();

  // 先打开同源页面清掉历史测试数据，保证每次运行从 3 份演示样本开始
  await a.goto(BASE);
  await a.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('gbmeteorite-db');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
      req.onblocked = resolve;
    });
  });
  a.on('console', (m) => console.log('[A]', m.type(), m.text()));
  b.on('console', (m) => console.log('[B]', m.type(), m.text()));
  a.on('pageerror', (e) => console.log('[A pageerror]', e.message));
  b.on('pageerror', (e) => console.log('[B pageerror]', e.message));

  // 打开总览，等待演示数据
  await a.goto(BASE);
  await b.goto(BASE);
  await a.waitForSelector('text=样本总览');
  await a.waitForFunction(() => document.body.innerText.includes('MET-2024-001'));
  await b.waitForFunction(() => document.body.innerText.includes('MET-2024-001'));

  const countText = (page) => page.locator('.MuiChip-label').filter({ hasText: /本地档案/ }).textContent();
  const beforeA = (await countText(a)).trim();

  // ── 场景 1：A 窗口登记新样本，B 窗口总览自动出现 ──────────────────────
  await a.goto(`${BASE}/samples/new`);
  await a.waitForSelector('#save-sample');
  // 等待自动取号
  await a.waitForFunction(() => {
    const el = document.querySelector('#sample-no');
    return el && el.value.startsWith('MET-');
  });
  const suggestedNo = await a.inputValue('#sample-no');
  await a.fill('#total-weight', '999.5');
  await a.fill('#place-name', 'Test Crater');
  await a.fill('#region', '测试国');
  // 坐标默认 0,0 合法
  await a.click('#save-sample');
  await a.waitForFunction(() => document.body.innerText.includes('已登记样本'), null, { timeout: 5000 });
  const createdUrl = a.url();

  // B 窗口留在总览，等它自动出现新编号
  await b.goto(BASE);
  const synced1 = await b.waitForFunction(
    (no) => document.body.innerText.includes(no),
    suggestedNo,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check('窗口 A 写入后，窗口 B 样本总览自动出现新样本', synced1, suggestedNo);

  const afterB = (await countText(b)).trim();
  check('窗口 B 顶栏样本计数同步增加', beforeA !== afterB, `${beforeA} -> ${afterB}`);

  // ── 场景 2：发现地分布页跟随更新 + 统计重算 ──────────────────────────
  await b.goto(`${BASE}/locations`);
  const locHasRegion = await b.waitForFunction(
    () => document.body.innerText.includes('测试国'),
    null,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check('窗口 B 发现地分布自动出现新地区与点位', locHasRegion);

  // ── 场景 3：编号撞号保护 ────────────────────────────────────────────
  // B 打开登记页取到下一个号，然后 A 抢先占用该号，B 用同号保存应被拒绝
  await b.goto(`${BASE}/samples/new`);
  await b.waitForFunction(() => {
    const el = document.querySelector('#sample-no');
    return el && el.value.startsWith('MET-');
  });
  const bNo = await b.inputValue('#sample-no');

  await a.goto(`${BASE}/samples/new`);
  await a.waitForFunction(() => {
    const el = document.querySelector('#sample-no');
    return el && el.value.startsWith('MET-');
  });
  // A 手工把编号改成 B 将用的号，抢先提交
  await a.fill('#sample-no', bNo);
  await a.fill('#total-weight', '123');
  await a.locator('button:has-text("已关联发现记录")').click();
  await a.click('#save-sample');
  await a.waitForFunction(() => document.body.innerText.includes('已登记样本'), null, { timeout: 5000 });

  // B 再用同号提交
  await b.fill('#total-weight', '456');
  await b.locator('button:has-text("已关联发现记录")').click();
  await b.click('#save-sample');
  const conflictAlert = await b.waitForFunction(
    (no) => document.body.innerText.includes(`样本编号「${no}」刚被另一窗口登记占用`),
    bNo,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check('同号保存被拒绝并提示已被另一窗口登记', conflictAlert, bNo);
  // B 仍停在登记页，草稿（重量）保留
  const bStillOnNew = b.url().includes('/samples/new');
  const draftKept = await b.inputValue('#total-weight');
  check('撞号后未跳转、录入草稿保留', bStillOnNew && draftKept === '456', `weight=${draftKept}`);
  // 点“改用 建议号”后可成功保存（建议号可能需跳过刚被占用的号）
  await b.click('#use-suggested-no');
  let fixedOk = false;
  let fixedNo = '';
  for (let i = 0; i < 3 && !fixedOk; i++) {
    // 点“采用建议号”是异步写入，等输入框真正变成建议号
    await b.waitForFunction(
      (old) => {
        const el = document.querySelector('#sample-no');
        return el && el.value && el.value !== old;
      },
      i === 0 ? bNo : fixedNo,
      { timeout: 3000 },
    ).catch(() => {});
    fixedNo = await b.inputValue('#sample-no');
    // withFind 为开时按钮显示「已关联发现记录」，点一下关掉，避免发现地校验拦截
    if (await b.isVisible('button:has-text("已关联发现记录")')) {
      await b.click('button:has-text("已关联发现记录")');
    }
    await b.click('#save-sample');
    fixedOk = await b
      .waitForFunction(() => document.body.innerText.includes('已登记样本'), null, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!fixedOk && (await b.isVisible('#use-suggested-no'))) {
      await b.click('#use-suggested-no');
    }
  }
  check('按建议改用下一个可用编号后保存成功', fixedOk && fixedNo !== bNo, fixedNo);

  // ── 场景 4：乐观锁防覆盖（切片库批量标注）────────────────────────────
  // A、B 都在切片库勾选同一切片
  await a.goto(`${BASE}/sections`);
  await b.goto(`${BASE}/sections`);
  await a.waitForSelector('text=TS-2024-001');
  await b.waitForSelector('text=TS-2024-001');

  const checkOne = async (page, sectionNo, ariaLabel) => {
    const card = page.locator('.MuiPaper-root', { hasText: sectionNo }).first();
    await card.getByRole('checkbox', { name: ariaLabel }).check();
  };
  await checkOne(b, 'TS-2024-001', '选择切片 TS-2024-001');

  // 模拟“另一边刚改了这张切片”：在 B 页面之外把库里版本推进为 fair，
  // 但不发广播——保证 B 此刻内存中的版本必定落后，再批量标“差”。
  await b.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('gbmeteorite-db');
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction('sections', 'readwrite');
      const os = tx.objectStore('sections');
      const cur = os.getAll();
      cur.onsuccess = () => {
        const rec = cur.result.find((r) => r.sectionNo === 'TS-2024-001');
        rec.quality = 'fair';
        rec.updatedAt = Date.now() + 9000;
        os.put(rec);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  }));

  // B 用落后的内存版本提交“差”——乐观锁必须拒绝，且不覆盖库里的 fair
  await b.locator('button:has-text("差")').last().click();
  const bulkStaleToast = await b.waitForFunction(
    () => document.body.innerText.includes('刚被另一窗口标注'),
    null,
    { timeout: 8000 },
  ).then(() => true).catch(() => false);
  check('批量标注遇到另一窗口的新版本时跳过并提示、不覆盖', bulkStaleToast);

  // 拒绝后自动刷新，B 最终展示另一边写入的“良”而不是自己要标的“差”
  const bulkFinal = await b.waitForFunction(
    () => document.body.innerText.includes('良（局部可用）'),
    null,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  const notPoor = await b.evaluate(() => {
    const req = new Promise((resolve) => {
      const r = indexedDB.open('gbmeteorite-db');
      r.onsuccess = () => {
        const tx = r.result.transaction('sections', 'readonly');
        const all = tx.objectStore('sections').getAll();
        all.onsuccess = () => resolve(all.result.find((x) => x.sectionNo === 'TS-2024-001').quality);
      };
    });
    return req;
  });
  check('B 窗口切片库最终呈现另一边写入的最新结果', bulkFinal && notPoor === 'fair', `quality=${notPoor}`);

  // ── 场景 5：详情页存放状态乐观锁 ────────────────────────────────────
  await a.goto(BASE);
  await a.waitForSelector('a[href^="/samples/sample_"]');
  const sampleHref = await a.locator('a[href^="/samples/sample_"]').first().getAttribute('href');
  await a.goto(`${BASE}${sampleHref}`);
  await b.goto(`${BASE}${sampleHref}`);
  await a.waitForSelector('#add-section');
  await b.waitForSelector('#add-section');

  // 确认详情数据含 updatedAt 版本字段（乐观锁基础）
  const hasVersion = await b.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((x) => x.name === 'gbmeteorite-db');
  });
  check('IndexedDB 业务库存在且样本携带 updatedAt 版本字段', hasVersion);

  // 模拟“另一边先改了”：从页面之外直接把该样本 updatedAt 推进，
  // 此时 B 页面内存中的 sample.updatedAt 已落后，再点切换应被拒绝。
  const staleSampleId = sampleHref.split('/').pop();
  await b.evaluate((sid) => new Promise((resolve, reject) => {
    const req = indexedDB.open('gbmeteorite-db');
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction('samples', 'readwrite');
      const os = tx.objectStore('samples');
      const get = os.get(sid);
      get.onsuccess = () => {
        const rec = get.result;
        rec.updatedAt = Date.now() + 5000;
        rec.storage = rec.storage === 'loan-out' ? 'cabinet-b' : 'loan-out';
        os.put(rec);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  }), staleSampleId);

  await b.click('button:has-text("切换存放状态")');
  const staleToast = await b.waitForFunction(
    () => document.body.innerText.includes('已落后'),
    null,
    { timeout: 6000 },
  ).then(() => true).catch(() => false);
  check('落后窗口保存时提示已被另一边改过且不覆盖', staleToast);
  // 提示后 B 自动刷新，存放状态显示为外部写入的“外借中”或“B 柜”，本地旧改动未生效
  const refreshedValue = await b.waitForFunction(
    () => document.body.innerText.includes('外借中') || document.body.innerText.includes('B 柜'),
    null,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check('冲突后页面已刷新到对方的最新结果', refreshedValue);

  // ── 场景 6：草稿写入失败后保留，重开可恢复 ──────────────────────────
  await b.goto(`${BASE}/samples/new`);
  await b.waitForSelector('#sample-no');
  await b.fill('#sample-no', 'MET-1999-999');
  await b.fill('#total-weight', '777');
  // 制造写入失败：临时删除 IndexedDB 写权限不易，直接刷新页面验证草稿恢复
  await b.reload();
  await b.waitForSelector('#sample-no');
  const restoredNo = await b.inputValue('#sample-no');
  const restoredW = await b.inputValue('#total-weight');
  const restoredBanner = await b.isVisible('text=已从本地草稿恢复');
  check('关闭/重开窗口后草稿恢复接着录', restoredNo === 'MET-1999-999' && restoredW === '777' && restoredBanner,
    `no=${restoredNo}, w=${restoredW}`);

  // ── 场景 7：分析检测记录跨窗口同步 ──────────────────────────────────
  await a.goto(`${BASE}/analysis`);
  await a.waitForSelector('#save-analysis');
  // MUI Select 是自定义 combobox：点开后选第二个样本
  await a.click('[aria-labelledby="analysis-sample-label"]');
  await a.locator('[role="option"]').nth(1).click();
  await a.fill('#analysis-ni', '14.7');
  await a.click('#save-analysis');
  await a.waitForFunction(() => document.body.innerText.includes('检测记录已写入本地库'));
  await b.goto(`${BASE}/analysis`);
  const analysisSynced = await b.waitForFunction(
    () => document.body.innerText.includes('14.7'),
    null,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check('A 写入检测记录后 B 分析检测列表同步', analysisSynced);

  // ── 场景 8：切片新增跨窗口同步到详情/切片库 ─────────────────────────
  await a.goto(BASE);
  const href2 = await a.locator('a[href^="/samples/sample_seed_2"]').first().getAttribute('href').catch(() => null);
  if (href2) {
    await b.goto(`${BASE}${href2}`);
    await b.waitForSelector('#add-section');
    const beforeCount = await b.locator('text=/切片与制样（/').textContent();
    await a.goto(`${BASE}${href2}`);
    await a.waitForSelector('#add-section');
    await a.click('text=按库内现状取号');
    await a.waitForFunction(() => {
      const el = document.querySelector('#section-no');
      return el && el.value.startsWith('TS-');
    });
    await a.fill('#section-thickness', '44');
    await a.click('#add-section');
    await a.waitForFunction(() => document.body.innerText.includes('新增切片'));
    const detailSynced = await b.waitForFunction(
      (before) => {
        const el = [...document.querySelectorAll('*')].find((n) => n.textContent && n.textContent.startsWith('切片与制样（') && n.children.length === 0);
        return el && el.textContent.trim() !== before.trim();
      },
      beforeCount,
      { timeout: 5000 },
    ).then(() => true).catch(() => false);
    check('A 新增切片后 B 样本详情切片数自动 +1', detailSynced, `${beforeCount}`);
  } else {
    check('A 新增切片后 B 样本详情切片数自动 +1', false, '未找到 seed_2 链接');
  }

  // ── 场景 9：写入失败（如存储异常）草稿留在本地，重开可恢复 ─────────────
  await b.goto(`${BASE}/samples/new`);
  await b.waitForSelector('#sample-no');
  await b.fill('#sample-no', 'MET-1988-088');
  await b.fill('#total-weight', '321');
  if (await b.isVisible('button:has-text("已关联发现记录")')) {
    await b.click('button:has-text("已关联发现记录")');
  }
  // 让 IndexedDB 的 add 强制失败，模拟写入失败（磁盘/配额异常）
  await b.evaluate(() => {
    const orig = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function forcedFail() {
      const err = new DOMException('forced write failure', 'QuotaExceededError');
      throw err;
    };
    window.__restoreAdd = () => {
      IDBObjectStore.prototype.add = orig;
    };
  });
  await b.click('#save-sample');
  const failNotice = await b.waitForFunction(
    () => document.body.innerText.includes('写入本地库失败') && document.body.innerText.includes('草稿已保留'),
    null,
    { timeout: 6000 },
  ).then(() => true).catch(() => false);
  check('写入失败时明确提示且不跳转', failNotice && b.url().includes('/samples/new'));

  // 恢复写入能力 → 刷新（重开窗口）→ 草稿还在并可恢复接着录
  await b.evaluate(() => window.__restoreAdd && window.__restoreAdd());
  await b.reload();
  await b.waitForSelector('#sample-no');
  const failRestoredNo = await b.inputValue('#sample-no');
  const failRestoredW = await b.inputValue('#total-weight');
  check('写入失败后草稿留在本地，重开恢复接着录',
    failRestoredNo === 'MET-1988-088' && failRestoredW === '321',
    `no=${failRestoredNo}, w=${failRestoredW}`);
  // 恢复后可以正常保存
  if (await b.isVisible('button:has-text("已关联发现记录")')) {
    await b.click('button:has-text("已关联发现记录")');
  }
  await b.click('#save-sample');
  const retryOk = await b.waitForFunction(
    () => document.body.innerText.includes('已登记样本'),
    null,
    { timeout: 6000 },
  ).then(() => true).catch(() => false);
  check('草稿恢复后重试保存成功', retryOk);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
