'use strict';

/* 全局状态：最近一次从服务器获取的全量数据（含重放结果） */
let state = null;
let editingCue = null; // 正在编辑的提示号，null 表示新增模式

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

function toast(msg, okStyle) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('ok', !!okStyle);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || '操作失败');
    throw new Error(data.error || '操作失败');
  }
  state = data; // 所有变更接口都返回最新全量状态
  render();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function locationOptions(selected) {
  return state.locations
    .map((l) => {
      const label = l.unlimited ? `${l.name}（不限）` : `${l.name}（限一件）`;
      return `<option value="${esc(l.name)}" ${l.name === selected ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

function propOptions(selected) {
  return state.props
    .map((p) => `<option value="${esc(p.name)}" ${p.name === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');
}

/* ---------- 渲染 ---------- */

function renderLocations() {
  const ul = $('#location-list');
  ul.innerHTML = state.locations
    .map((l) => `
      <li class="${l.unlimited ? 'backstage' : ''}">
        <strong>${esc(l.name)}</strong>
        <span class="cap">${l.unlimited ? '容量不限' : '限一件'}</span>
        ${l.unlimited ? '' : `<button class="link" data-del-loc="${esc(l.name)}" title="删除区位">✕</button>`}
      </li>`)
    .join('');
  $('#prop-location').innerHTML = locationOptions();
}

function renderProps() {
  const tbody = $('#prop-rows');
  tbody.innerHTML = state.props
    .map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td><select data-prop-loc="${esc(p.name)}">${locationOptions(p.location)}</select></td>
        <td><button class="link" data-del-prop="${esc(p.name)}">删除</button></td>
      </tr>`)
    .join('');
}

function renderCueForm() {
  $('#cue-number').disabled = editingCue !== null;
  $('#cue-submit').textContent = editingCue !== null ? `保存修改（提示号 ${editingCue}）` : '保存提示';
  $('#cue-cancel').classList.toggle('hidden', editingCue === null);
}

function addTransferRow(t) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="t-prop">${propOptions(t && t.prop)}</select></td>
    <td><select class="t-from">${locationOptions(t && t.from)}</select></td>
    <td><select class="t-to">${locationOptions(t && t.to)}</select></td>
    <td><button type="button" class="link t-remove">移除</button></td>`;
  tr.querySelector('.t-remove').onclick = () => {
    tr.remove();
    if (!$('#transfer-rows').children.length) addTransferRow();
    clearPreview();
  };
  $('#transfer-rows').appendChild(tr);
}

function resetCueForm() {
  editingCue = null;
  $('#cue-number').value = '';
  $('#cue-note').value = '';
  $('#transfer-rows').innerHTML = '';
  addTransferRow();
  renderCueForm();
  clearPreview();
}

function renderCues() {
  const box = $('#cue-list');
  if (!state.cues.length) {
    box.innerHTML = '<p class="hint">还没有提示，请在上方录入。</p>';
    return;
  }
  const resultByNumber = new Map(state.replay.results.map((r) => [r.number, r]));
  box.innerHTML = state.cues
    .map((c) => {
      const r = resultByNumber.get(c.number);
      const badge = r && r.ok
        ? '<span class="badge ok">✓ 已生效</span>'
        : '<span class="badge fail">✗ 整组未生效</span>';
      const transfers = c.transfers
        .map((t) => `<div>「${esc(t.prop)}」 ${esc(t.from)} <span class="arrow">→</span> ${esc(t.to)}</div>`)
        .join('');
      const errors = r && !r.ok
        ? `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
        : '';
      return `
        <div class="cue-item ${r && r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${c.number}</span>
            <span class="note">${esc(c.note || '')}</span>
            ${badge}
          </div>
          <div class="cue-transfers">${transfers}</div>
          ${errors}
          <div class="cue-actions">
            <button class="small ghost" data-edit-cue="${c.number}">编辑</button>
            <button class="small danger" data-del-cue="${c.number}">删除</button>
          </div>
        </div>`;
    })
    .join('');
}

function renderReplay() {
  const box = $('#replay-results');
  if (!state.replay.results.length) {
    box.innerHTML = '<p class="hint">暂无提示可重放。</p>';
  } else {
    box.innerHTML = state.replay.results
      .map((r) => `
        <div class="cue-item ${r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${r.number}</span>
            <span class="note">${esc(r.note || '')}</span>
            ${r.ok ? '<span class="badge ok">✓ 整组生效</span>' : '<span class="badge fail">✗ 整组未生效</span>'}
          </div>
          ${r.ok ? '' : `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`}
        </div>`)
      .join('');
  }

  $('#final-board').innerHTML = Object.entries(state.replay.finalLocations)
    .map(([loc, props]) => `
      <div class="loc ${loc === '后台' ? 'backstage' : ''}">
        <div class="loc-name">${esc(loc)}</div>
        ${props.length ? props.map((p) => `<span class="chip">${esc(p)}</span>`).join('') : '<span class="empty">（空）</span>'}
      </div>`)
    .join('');
}

function render() {
  renderLocations();
  renderProps();
  renderCueForm();
  renderCues();
  renderReplay();
}

/* ---------- 事件 ---------- */

$('#location-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#location-name').value.trim();
  if (!name) return;
  api('/api/locations', 'POST', { name }).then(() => { $('#location-name').value = ''; }).catch(() => {});
});

$('#location-list').addEventListener('click', (e) => {
  const name = e.target.dataset.delLoc;
  if (!name) return;
  if (confirm(`删除区位「${name}」？`)) api(`/api/locations/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#prop-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#prop-name').value.trim();
  const location = $('#prop-location').value;
  if (!name) return;
  api('/api/props', 'POST', { name, location }).then(() => { $('#prop-name').value = ''; }).catch(() => {});
});

$('#prop-rows').addEventListener('change', (e) => {
  const name = e.target.dataset.propLoc;
  if (!name) return;
  api(`/api/props/${encodeURIComponent(name)}`, 'PUT', { location: e.target.value }).catch(() => {});
});

$('#prop-rows').addEventListener('click', (e) => {
  const name = e.target.dataset.delProp;
  if (!name) return;
  if (confirm(`删除道具「${name}」？引用它的提示在重放时会报错。`))
    api(`/api/props/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#add-transfer').addEventListener('click', () => { addTransferRow(); clearPreview(); });

$('#cue-cancel').addEventListener('click', resetCueForm);

/* ---------- 试排预览（不写库） ---------- */

function collectCueForm() {
  return {
    number: Number($('#cue-number').value),
    note: $('#cue-note').value.trim(),
    transfers: [...$('#transfer-rows').querySelectorAll('tr')].map((tr) => ({
      prop: tr.querySelector('.t-prop').value,
      from: tr.querySelector('.t-from').value,
      to: tr.querySelector('.t-to').value,
    })),
  };
}

function clearPreview() {
  const panel = $('#cue-preview-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function statusSideHtml(side) {
  if (!side) return '<span class="pv-none">（序列中不存在）</span>';
  if (side.ok) return '<span class="badge ok">✓ 生效</span>';
  return `<span class="badge fail">✗ 未生效</span>
    <ul class="cue-errors">${side.errors.map((e) => `<li>${esc(e)}</li>`).join('') || '<li>（无冲突原因）</li>'}</ul>`;
}

function renderPreview(data) {
  const panel = $('#cue-preview-panel');
  const modeText = data.mode === 'replace'
    ? `假设<strong>替换</strong>提示 ${data.draft.number} 的整组内容`
    : `假设<strong>新增</strong>提示 ${data.draft.number}`;

  const cueBlocks = data.changedCues
    .map((c) => {
      const flip = !c.before || !c.after
        ? '<span class="pv-tag new">序列成员变化</span>'
        : c.after.ok
          ? '<span class="pv-flip up">未生效 → 生效 ↑</span>'
          : '<span class="pv-flip down">生效 → 未生效 ↓</span>';
      return `
        <div class="pv-cue">
          <div class="pv-cue-head"><span class="num">提示 ${c.number}</span> ${flip}</div>
          <div class="pv-sides">
            <div class="pv-side"><div class="pv-side-label">现行</div>${statusSideHtml(c.before)}</div>
            <div class="pv-arrow">→</div>
            <div class="pv-side"><div class="pv-side-label">假设</div>${statusSideHtml(c.after)}</div>
          </div>
        </div>`;
    })
    .join('');

  const movedBlocks = data.movedProps.length
    ? `<ul class="pv-moved">${data.movedProps
        .map((m) => `<li>「${esc(m.prop)}」：${m.from ? esc(m.from) : '（不存在）'} <span class="arrow">→</span> ${m.to ? esc(m.to) : '（不存在）'}</li>`)
        .join('')}</ul>`
    : '<p class="hint">没有道具的最终区位发生变化。</p>';

  panel.innerHTML = `
    <div class="pv-title">🧪 试排预览 · ${modeText}（仅内存重放，未写入数据库）</div>
    <h4>生效状态发生变化的提示</h4>
    ${cueBlocks || '<p class="hint">草稿加入后，所有提示的生效状态均无变化。</p>'}
    <h4>最终区位发生变化的道具</h4>
    ${movedBlocks}`;
  panel.classList.remove('hidden');
}

function renderPreviewError(msg) {
  const panel = $('#cue-preview-panel');
  panel.innerHTML = `<div class="pv-title">🧪 试排预览</div><div class="pv-error">草稿不合法：${esc(msg)}</div>`;
  panel.classList.remove('hidden');
}

$('#cue-preview').addEventListener('click', async () => {
  const btn = $('#cue-preview');
  clearPreview();
  btn.disabled = true;
  btn.textContent = '重放中…';
  try {
    const res = await fetch('/api/cues/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectCueForm()),
    });
    const data = await res.json();
    if (!res.ok) {
      renderPreviewError(data.error || '预览失败');
    } else {
      renderPreview(data);
    }
  } catch (err) {
    renderPreviewError('无法连接服务器');
  } finally {
    btn.disabled = false;
    btn.textContent = '🧪 试排预览（不保存）';
  }
});

// 表单内容一旦改动，旧预览即失效
$('#cue-form').addEventListener('input', clearPreview);
$('#cue-form').addEventListener('change', clearPreview);

$('#cue-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { number, note, transfers } = collectCueForm();
  const req = editingCue !== null
    ? api(`/api/cues/${editingCue}`, 'PUT', { note, transfers })
    : api('/api/cues', 'POST', { number, note, transfers });
  req.then(resetCueForm).catch(() => {});
});

$('#cue-list').addEventListener('click', (e) => {
  const editNum = e.target.dataset.editCue;
  const delNum = e.target.dataset.delCue;
  if (editNum) {
    const cue = state.cues.find((c) => c.number === Number(editNum));
    if (!cue) return;
    editingCue = cue.number;
    $('#cue-number').value = cue.number;
    $('#cue-note').value = cue.note || '';
    $('#transfer-rows').innerHTML = '';
    cue.transfers.forEach((t) => addTransferRow(t));
    renderCueForm();
    clearPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (delNum) {
    if (confirm(`删除提示 ${delNum}？删除后将按提示号重放全部剩余提示。`))
      api(`/api/cues/${delNum}`, 'DELETE').catch(() => {});
  }
});

/* ---------- 批量平移提示号 ---------- */

let shiftPlan = null; // 最近一次预览返回的方案（含冲突信息），输入一变即失效

function collectShiftForm() {
  return {
    from: Number($('#shift-from').value),
    to: Number($('#shift-to').value),
    shift: Number($('#shift-delta').value),
  };
}

function clearShiftPreview() {
  shiftPlan = null;
  $('#shift-apply').disabled = true;
  const panel = $('#shift-preview-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function renderShiftPlan(data) {
  shiftPlan = data;
  const conflictSet = new Set(data.conflicts || []);
  const rows = data.moves
    .map((m) => {
      const hit = conflictSet.has(m.to);
      return `<li class="${hit ? 'shift-hit' : ''}">
        <span class="num">${m.from}</span> <span class="arrow">→</span> <span class="num">${m.to}</span>
        <span class="shift-note">${esc(m.note || '')}</span>
        ${hit ? '<span class="badge fail">冲突</span>' : ''}
      </li>`;
    })
    .join('');
  const summary = conflictSet.size
    ? `<div class="pv-error">新号 ${[...conflictSet].join('、')} 与区间外已有提示冲突，整批不可执行。</div>`
    : `<p class="hint">共 ${data.moves.length} 条提示，校验通过，可执行平移。</p>`;
  const panel = $('#shift-preview-panel');
  panel.innerHTML = `
    <div class="pv-title">⇄ 平移预览：闭区间每条提示的原号 → 新号（尚未写入数据库）</div>
    <ul class="shift-list">${rows}</ul>
    ${summary}`;
  panel.classList.remove('hidden');
  $('#shift-apply').disabled = conflictSet.size > 0;
}

function renderShiftError(msg) {
  shiftPlan = null;
  $('#shift-apply').disabled = true;
  const panel = $('#shift-preview-panel');
  panel.innerHTML = `<div class="pv-title">⇄ 批量平移提示号</div><div class="pv-error">${esc(msg)}</div>`;
  panel.classList.remove('hidden');
}

$('#shift-preview').addEventListener('click', async () => {
  const btn = $('#shift-preview');
  clearShiftPreview();
  btn.disabled = true;
  try {
    const res = await fetch('/api/cues/shift/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectShiftForm()),
    });
    const data = await res.json();
    if (!res.ok) renderShiftError(data.error || '预览失败');
    else renderShiftPlan(data);
  } catch (err) {
    renderShiftError('无法连接服务器');
  } finally {
    btn.disabled = false;
  }
});

// 输入一旦改动，旧预览即失效，须重新预览
$('#shift-form').addEventListener('input', clearShiftPreview);

$('#shift-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!shiftPlan || (shiftPlan.conflicts || []).length) return;
  const body = collectShiftForm();
  if (!confirm(`确认将区间 [${body.from}, ${body.to}] 内的 ${shiftPlan.moves.length} 条提示平移 ${body.shift > 0 ? '+' : ''}${body.shift}？`))
    return;
  const btn = $('#shift-apply');
  btn.disabled = true;
  try {
    const res = await fetch('/api/cues/shift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // 执行时校验失败（如预览后数据变化）：整批拒绝，标出冲突号
      if (data.moves) renderShiftPlan(data);
      else renderShiftError(data.error || '平移被拒绝');
      toast(data.error || '平移被拒绝');
      return;
    }
    state = data; // 成功：服务端已按新号全量重放，刷新整个页面
    render();
    clearShiftPreview();
    resetCueForm(); // 编辑中的提示号可能已被平移，退出编辑态避免指向旧号
    $('#shift-from').value = $('#shift-to').value = $('#shift-delta').value = '';
    toast('平移完成，已按新号全量重放', true);
  } catch (err) {
    renderShiftError('无法连接服务器');
  }
});

/* ---------- 启动 ---------- */

api('/api/state').then(resetCueForm).catch(() => toast('无法连接服务器'));
