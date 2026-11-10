/*
 * 种梦 Seedream · 保守备份助手 v2.0 (2026-11-10)
 * 适配 https://github.com/noperfectism/tu 的 IndexedDB：seedream-pocket / items
 * 只读：没有 readwrite、put、add、delete、clear、localStorage 写入或网络请求。
 * 不会在缺少数据库时创建新数据库：onupgradeneeded 立即 abort。
 * 先导出 5 张测试图片，用户确认成功后才允许分包导出。
 * 每包至多 50 张、100 MiB；每次只从数据库取 1 条记录。
 * 原始图片按字节原样放入无压缩 ZIP，附每张的参数信息 JSON。
 * 注意：Web App / iOS / 人工保存流程不能承诺零风险。
 */
(() => {
  'use strict';

  const DB_NAME = 'seedream-pocket';
  const STORE_NAME = 'items';
  const TEST_COUNT = 5;
  const BATCH_COUNT = 50;
  const MAX_BATCH_SIZE = 100 * 1024 * 1024;
  const CHUNK = 1024 * 1024;
  const area = document.querySelector('#storeRows')?.parentElement;
  if (!area || document.getElementById('sd-safe-backup')) return;

  const root = document.createElement('section');
  root.id = 'sd-safe-backup';
  root.style.cssText = 'margin-top:16px;padding:13px;border:1px solid var(--line,#bbb);border-radius:12px;display:flex;flex-direction:column;gap:9px;';

  function node(tag, content) {
    const n = document.createElement(tag);
    if (content != null) n.textContent = content;
    return n;
  }
  function action(text) {
    const b = node('button', text);
    b.className = 'btn';
    b.type = 'button';
    b.style.width = '100%';
    return b;
  }
  function styleSmall(n) { n.style.cssText = 'font-size:13px;line-height:1.6;white-space:pre-wrap;'; return n; }
  function say(text) { status.textContent = text; }
  function show(element, visible) { element.hidden = !visible; element.style.display = visible ? '' : 'none'; }
  function mib(n) { return (n / 1048576).toFixed(1) + ' MiB'; }
  function errorText(e) { return e && e.message ? e.message : String(e); }

  const heading = node('strong', '图片安全备份（只读测试版）');
  const intro = styleSmall(node('p', '先检查数量，再测试导出 5 张；确认测试 ZIP 在「文件」中保存、能解压后，才能导出完整图库。每包最多 50 张。全程不删除原图，不上传图片。'));
  const scan = action('第一步：只读检查图库数量');
  const test = action('第二步：制作 5 张测试 ZIP');
  const share = action('分享当前 ZIP → 存储到「文件」');
  const download = node('a', '或：下载当前 ZIP');
  download.className = 'btn';
  download.style.cssText = 'display:block;text-align:center;text-decoration:none;width:100%;';
  const confirmRow = node('label');
  confirmRow.style.cssText = 'display:flex;align-items:start;gap:9px;font-size:13px;line-height:1.6;';
  const confirm = document.createElement('input');
  confirm.type = 'checkbox';
  confirm.style.cssText = 'margin-top:4px;accent-color:var(--ink,#333);';
  confirmRow.append(confirm, node('span', '我已经将测试 ZIP 保存到「文件」App，解压后看到了 5 张图片（或图库不足 5 张时的实际张数）。'));
  const full = action('第三步：开始分批导出完整图库');
  const rangeRow = node('label');
  rangeRow.style.cssText = 'font-size:13px;display:flex;align-items:center;gap:9px;';
  rangeRow.append(node('span', '从第几包开始：'));
  const packageInput = document.createElement('input');
  packageInput.type = 'number';
  packageInput.min = '1';
  packageInput.step = '1';
  packageInput.value = '1';
  packageInput.style.cssText = 'width:72px;font-size:16px;padding:6px;';
  rangeRow.append(packageInput);
  const next = action('确认已保存这包，制作下一包');
  const status = styleSmall(node('div', '尚未检查图库。请从原来的 iPhone「种梦」桌面图标打开，避免进入另一份浏览器存储。'));
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  root.append(heading, intro, scan, test, share, download, confirmRow, rangeRow, full, next, status);
  area.append(root);
  show(test, false);
  show(share, false);
  show(download, false);
  show(confirmRow, false);
  show(rangeRow, false);
  show(full, false);
  show(next, false);

  let keys = null;
  let testPrepared = false;
  let inFullMode = false;
  let currentPart = 0; // zero-based
  let totalParts = 0;
  let readyFile = null;
  let readyURL = null;
  let busy = false;

  function clearReady() {
    if (readyURL) URL.revokeObjectURL(readyURL);
    readyURL = null;
    readyFile = null;
    show(share, false);
    show(download, false);
    show(next, false);
    download.removeAttribute('href');
  }
  function updateLock() {
    scan.disabled = busy;
    test.disabled = busy;
    full.disabled = busy || !testPrepared || !confirm.checked;
    next.disabled = busy;
    packageInput.disabled = busy;
  }

  // Calling open(name) without a version on a missing database would normally create it.
  // Abort that upgrade immediately: failure is safe and alerts the user to the wrong origin.
  function openExistingDatabase() {
    return new Promise((resolve, reject) => {
      let creating = false;
      let done = false;
      let request;
      try { request = indexedDB.open(DB_NAME); }
      catch (e) { reject(e); return; }
      request.onupgradeneeded = () => {
        creating = true;
        try { request.transaction.abort(); } catch (_) { /* abort attempted */ }
      };
      request.onerror = () => {
        if (!done) {
          done = true;
          reject(new Error(creating ? '此网页环境没有现成的图库数据库。请回到原来的「种梦」桌面图标，不要清理数据。' : '无法打开图片数据库：' + errorText(request.error)));
        }
      };
      request.onblocked = () => {
        if (!done) { done = true; reject(new Error('数据库正在被其他页面占用，请关闭其他打开的「种梦」页面再试。')); }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (done) { db.close(); return; }
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.close(); done = true;
          reject(new Error('数据结构不匹配（缺少 items），已停止；没有做任何修改。'));
          return;
        }
        db.onversionchange = () => db.close();
        done = true;
        resolve(db);
      };
    });
  }

  function readonlyRequest(db, operation) {
    return new Promise((resolve, reject) => {
      let transaction;
      try { transaction = db.transaction(STORE_NAME, 'readonly'); }
      catch (e) { reject(e); return; }
      let result;
      let request;
      try { request = operation(transaction.objectStore(STORE_NAME)); }
      catch (e) { try { transaction.abort(); } catch (_) {} reject(e); return; }
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || request.error || new Error('读取数据库失败'));
      transaction.onabort = () => reject(transaction.error || new Error('读取被终止'));
    });
  }

  async function scanKeys() {
    const db = await openExistingDatabase();
    try {
      const found = await readonlyRequest(db, store => store.getAllKeys());
      if (!Array.isArray(found) || found.length === 0) throw new Error('未读到任何图片记录。请确认当前确实是原来的「种梦」图标，不要清理浏览器数据。');
      return found;
    } finally { db.close(); }
  }

  // ZIP STORE (method=0) with per-entry CRC32; no CDN or external JS is needed.
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let j = 0; j < 8; j++) v = (v & 1) ? (0xedb88320 ^ (v >>> 1)) : (v >>> 1);
    crcTable[i] = v >>> 0;
  }
  function updateCrc(crc, bytes) {
    for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    return crc >>> 0;
  }
  async function crcForBlob(blob) {
    let value = 0xffffffff;
    for (let start = 0; start < blob.size; start += CHUNK) {
      const bytes = new Uint8Array(await blob.slice(start, Math.min(start + CHUNK, blob.size)).arrayBuffer());
      value = updateCrc(value, bytes);
    }
    return (value ^ 0xffffffff) >>> 0;
  }
  const encoder = new TextEncoder();
  function u16(v, offset, num) { v.setUint16(offset, num, true); }
  function u32(v, offset, num) { v.setUint32(offset, num >>> 0, true); }
  function zipTime(value) {
    const d = new Date(value);
    const safe = Number.isFinite(d.getTime()) ? d : new Date();
    const y = Math.max(1980, Math.min(2107, safe.getFullYear()));
    return [((y - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate(),
      (safe.getHours() << 11) | (safe.getMinutes() << 5) | (safe.getSeconds() >> 1)];
  }
  function zipHeaders(name, size, crc, date, offset) {
    const n = encoder.encode(name);
    if (n.length > 65535 || size > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP 文件过大');
    const [day, time] = zipTime(date);
    const l = new Uint8Array(30 + n.length);
    const a = new DataView(l.buffer);
    u32(a, 0, 0x04034b50); u16(a, 4, 20); u16(a, 6, 0x0800); u16(a, 8, 0);
    u16(a, 10, time); u16(a, 12, day);
    u32(a, 14, crc); u32(a, 18, size); u32(a, 22, size);
    u16(a, 26, n.length); u16(a, 28, 0); l.set(n, 30);
    const c = new Uint8Array(46 + n.length);
    const b = new DataView(c.buffer);
    u32(b, 0, 0x02014b50); u16(b, 4, 20); u16(b, 6, 20);
    u16(b, 8, 0x0800); u16(b, 10, 0);
    u16(b, 12, time); u16(b, 14, day);
    u32(b, 16, crc); u32(b, 20, size); u32(b, 24, size);
    u16(b, 28, n.length); u16(b, 30, 0); u16(b, 32, 0);
    u16(b, 34, 0); u16(b, 36, 0); u32(b, 38, 0); u32(b, 42, offset);
    c.set(n, 46);
    return { local: l, central: c };
  }
  function extension(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
    if (t.includes('png')) return 'png';
    if (t.includes('webp')) return 'webp';
    if (t.includes('avif')) return 'avif';
    if (t.includes('gif')) return 'gif';
    return 'img';
  }

  async function makeArchive(selectedKeys, firstIndex, kind, partIndex, countOfParts) {
    const db = await openExistingDatabase();
    const parts = [];
    const central = [];
    const manifestImages = [];
    let payloadBytes = 0;
    let offset = 0;
    let csize = 0;
    let entries = 0;
    const push = async (filename, data, date) => {
      const size = data instanceof Blob ? data.size : data.byteLength;
      const crc = data instanceof Blob ? await crcForBlob(data) : (updateCrc(0xffffffff, data) ^ 0xffffffff) >>> 0;
      const h = zipHeaders(filename, size, crc, date, offset);
      parts.push(h.local, data);
      central.push(h.central);
      offset += h.local.byteLength + size;
      csize += h.central.byteLength;
      entries++;
    };
    try {
      for (let i = 0; i < selectedKeys.length; i++) {
        // One IndexedDB record per readonly transaction. No getAll() of image Blobs.
        const key = selectedKeys[i];
        const record = await readonlyRequest(db, store => store.get(key));
        if (!record || !(record.blob instanceof Blob) || record.blob.size === 0) {
          throw new Error('第 ' + (firstIndex + i + 1) + ' 条记录不存在、没有图片或图片为空。已停止；没有跳过任何图片。');
        }
        if (payloadBytes + record.blob.size > MAX_BATCH_SIZE) {
          throw new Error('这一包超过 100 MiB 安全上限，已停止，请联系我调整每包张数。');
        }
        payloadBytes += record.blob.size;
        const ordinal = String(firstIndex + i + 1).padStart(6, '0');
        const filename = 'images/' + ordinal + '_seedream.' + extension(record.type || record.blob.type);
        say('正在制作' + (kind === 'test' ? '测试 ZIP' : '第 ' + (partIndex + 1) + '/' + countOfParts + ' 包') + '\n已读取：' + (i + 1) + '/' + selectedKeys.length + ' 张。请不要锁屏或离开种梦。');
        await push(filename, record.blob, record.created);
        manifestImages.push({
          filename, id: record.id, created: record.created, prompt: record.prompt,
          model: record.model, seed: record.seed, resolution: record.res,
          aspect_ratio: record.ratio, references_count: record.refsCount,
          cost_usd: record.cost, seconds: record.secs, width: record.w,
          height: record.h, mime_type: record.type || record.blob.type,
          bytes: record.blob.size
        });
        // Yield only between readonly transactions, never while a transaction is active.
        if (i % 5 === 4) await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { db.close(); }
    const manifest = {
      source: '种梦 Seedream (noperfectism/tu)', format_version: 2,
      export_time_utc: new Date().toISOString(), kind,
      total_library_at_scan: keys.length, images_in_archive: manifestImages.length,
      archive_number: kind === 'test' ? 0 : partIndex + 1,
      archive_count: kind === 'test' ? 0 : countOfParts,
      image_records: manifestImages
    };
    await push('metadata.json', encoder.encode(JSON.stringify(manifest, null, 2)), Date.now());
    const tail = new Uint8Array(22);
    const z = new DataView(tail.buffer);
    u32(z, 0, 0x06054b50); u16(z, 4, 0); u16(z, 6, 0);
    u16(z, 8, entries); u16(z, 10, entries);
    u32(z, 12, csize); u32(z, 16, offset); u16(z, 20, 0);
    if (offset + csize + tail.byteLength > 0xffffffff) throw new Error('ZIP 超出格式大小限制');
    return new Blob([...parts, ...central, tail], {type: 'application/zip'});
  }

  function exposeZip(blob, fileName) {
    clearReady();
    readyFile = new File([blob], fileName, {type: 'application/zip'});
    readyURL = URL.createObjectURL(blob);
    download.href = readyURL;
    download.download = fileName;
    show(share, true);
    show(download, true);
    if (inFullMode) show(next, true);
  }
  async function makePart() {
    if (!keys || busy) return;
    busy = true; updateLock(); clearReady();
    try {
      const start = currentPart * BATCH_COUNT;
      const selected = keys.slice(start, start + BATCH_COUNT);
      const blob = await makeArchive(selected, start, 'full', currentPart, totalParts);
      const filename = 'seedream-full-' + String(currentPart + 1).padStart(3, '0') + '-of-' + String(totalParts).padStart(3, '0') + '.zip';
      exposeZip(blob, filename);
      next.textContent = currentPart === totalParts - 1 ? '确认已保存最后一包，完成' : '确认已保存这包，制作下一包';
      say('已制作第 ' + (currentPart + 1) + '/' + totalParts + ' 包（' + selected.length + ' 张，' + mib(blob.size) + '）。\n请点「分享当前 ZIP」→「存储到文件」，再去「文件」确认文件确实存在。确认后才点下一包。\n如果中断，可以重新打开「种梦」，重新检查数量、测试后从对应包号继续。');
    } catch (e) {
      say('导出停止：' + errorText(e) + '\n原图库未被这个备份工具修改。不要清理数据或删除桌面图标。');
    } finally { busy = false; updateLock(); }
  }

  scan.addEventListener('click', async () => {
    if (busy) return;
    busy = true; updateLock();
    clearReady(); keys = null; testPrepared = false; inFullMode = false; confirm.checked = false;
    show(test, false); show(confirmRow, false); show(rangeRow, false); show(full, false);
    say('只读检查数据库……');
    try {
      keys = await scanKeys();
      totalParts = Math.ceil(keys.length / BATCH_COUNT);
      packageInput.max = String(totalParts);
      packageInput.value = '1';
      show(test, true);
      say('成功读取图库索引：共 ' + keys.length + ' 条记录。\n仅检查了 ID，没有读取全部图片，也没有修改数据。\n现在可以制作 ' + Math.min(TEST_COUNT, keys.length) + ' 张测试 ZIP。');
    } catch (e) { say('检查失败：' + errorText(e) + '\n不要删除「种梦」或清理网站数据。'); }
    finally { busy = false; updateLock(); }
  });
  test.addEventListener('click', async () => {
    if (busy || !keys) return;
    busy = true; updateLock(); clearReady(); inFullMode = false; testPrepared = false;
    confirm.checked = false; show(confirmRow, false); show(rangeRow, false); show(full, false);
    say('开始制作测试 ZIP……');
    try {
      const blob = await makeArchive(keys.slice(0, TEST_COUNT), 0, 'test', 0, 0);
      exposeZip(blob, 'seedream-test-' + Math.min(TEST_COUNT, keys.length) + '-images.zip');
      testPrepared = true;
      show(confirmRow, true);
      show(rangeRow, true);
      show(full, true);
      say('测试 ZIP 已准备好：' + Math.min(TEST_COUNT, keys.length) + ' 张，' + mib(blob.size) + '。\n请先分享保存到 iPhone「文件」App，再在「文件」中解压，确认图片可以打开。\n确认之前，不要勾选验证框，也不要进行完整备份。');
    } catch (e) { say('测试失败：' + errorText(e) + '\n原图库未被这个工具修改。'); }
    finally { busy = false; updateLock(); }
  });
  confirm.addEventListener('change', updateLock);
  full.addEventListener('click', async () => {
    if (busy || !keys || !testPrepared || !confirm.checked) return;
    const requested = Number(packageInput.value);
    if (!Number.isInteger(requested) || requested < 1 || requested > totalParts) {
      say('包号必须是 1 到 ' + totalParts + ' 的整数。'); return;
    }
    inFullMode = true; currentPart = requested - 1;
    await makePart();
  });
  next.addEventListener('click', async () => {
    if (busy || !inFullMode || !readyFile) return;
    if (currentPart + 1 === totalParts) {
      clearReady();
      say('所有批次已制作到最后一包。请在「文件」中核对共 ' + totalParts + ' 个 full ZIP（不包括 test ZIP），并确认每包能解压。\n若每包 50 张、最后一包为剩余张数，则应覆盖开始扫描的全部 ' + keys.length + ' 张。\n请继续保留原来的「种梦」图标和数据库。');
      return;
    }
    currentPart++;
    packageInput.value = String(currentPart + 1);
    await makePart();
  });
  share.addEventListener('click', () => {
    if (!readyFile) return;
    try {
      if (!navigator.share || (navigator.canShare && !navigator.canShare({files: [readyFile]}))) {
        say('系统不支持直接分享此 ZIP。请使用「下载当前 ZIP」；然后去「文件」App 检查。');
        return;
      }
      // Must be called synchronously from user gesture in iOS; no await before share().
      navigator.share({files: [readyFile], title: '种梦图库备份'})
        .then(() => say('已返回分享界面。请到「文件」App 检查 ZIP 是否真的保存成功，再继续下一包（分享完成不代表已经写入文件）。'))
        .catch(e => { if (e?.name !== 'AbortError') say('分享失败：' + errorText(e) + '\n请尝试「下载当前 ZIP」，不需要删除或修改图库。'); });
    } catch (e) { say('无法分享：' + errorText(e) + '\n请尝试下载方式。'); }
  });
})();
