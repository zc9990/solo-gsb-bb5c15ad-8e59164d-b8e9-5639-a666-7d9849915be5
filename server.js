'use strict';

const express = require('express');
const db = require('./db');
const { replay, diffReplays } = require('./replay');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const BACKSTAGE = '后台';

/* ---------- 读取全量状态（含重放结果） ---------- */

function loadBaseData() {
  const locations = db
    .prepare('SELECT name, unlimited FROM locations ORDER BY unlimited DESC, rowid')
    .all()
    .map((l) => ({ name: l.name, unlimited: !!l.unlimited }));

  const props = db.prepare('SELECT name, location FROM props ORDER BY rowid').all();

  const trStmt = db.prepare(
    'SELECT prop, from_loc, to_loc FROM transfers WHERE cue_number = ? ORDER BY id'
  );
  const cues = db
    .prepare('SELECT number, note FROM cues ORDER BY number')
    .all()
    .map((c) => ({
      number: c.number,
      note: c.note,
      transfers: trStmt.all(c.number).map((t) => ({ prop: t.prop, from: t.from_loc, to: t.to_loc })),
    }));

  return { locations, props, cues };
}

function loadState() {
  const { locations, props, cues } = loadBaseData();
  return { locations, props, cues, replay: replay(locations, props, cues) };
}

function ok(res) {
  res.json(loadState());
}

function bad(res, msg, code = 400) {
  res.status(code).json({ error: msg });
}

/* ---------- 查询 ---------- */

app.get('/api/state', (req, res) => ok(res));

/* ---------- 区位 ---------- */

app.post('/api/locations', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, '区位名称不能为空');
  if (db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name))
    return bad(res, `区位「${name}」已存在`, 409);
  db.prepare('INSERT INTO locations (name, unlimited) VALUES (?, 0)').run(name);
  ok(res);
});

app.delete('/api/locations/:name', (req, res) => {
  const name = req.params.name;
  if (name === BACKSTAGE) return bad(res, '「后台」是固有区位，不能删除');
  if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name))
    return bad(res, `区位「${name}」不存在`, 404);
  if (db.prepare('SELECT 1 FROM props WHERE location = ?').get(name))
    return bad(res, `区位「${name}」仍放有道具，无法删除`, 409);
  if (
    db.prepare('SELECT 1 FROM transfers WHERE from_loc = ? OR to_loc = ?').get(name, name)
  )
    return bad(res, `区位「${name}」仍被提示中的转移引用，无法删除`, 409);
  db.prepare('DELETE FROM locations WHERE name = ?').run(name);
  ok(res);
});

/* ---------- 道具 ---------- */

function checkInitialCapacity(location, excludeProp) {
  const loc = db.prepare('SELECT unlimited FROM locations WHERE name = ?').get(location);
  if (!loc) return `区位「${location}」不存在`;
  if (loc.unlimited) return null;
  const row = excludeProp
    ? db.prepare('SELECT name FROM props WHERE location = ? AND name != ?').get(location, excludeProp)
    : db.prepare('SELECT name FROM props WHERE location = ?').get(location);
  if (row) return `区位「${location}」初始只能放置一件道具（已放置「${row.name}」）`;
  return null;
}

app.post('/api/props', (req, res) => {
  const name = String(req.body.name || '').trim();
  const location = String(req.body.location || '').trim();
  if (!name) return bad(res, '道具名称不能为空');
  if (!location) return bad(res, '请选择初始区位');
  if (db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」已存在`, 409);
  const capErr = checkInitialCapacity(location, null);
  if (capErr) return bad(res, capErr, 409);
  db.prepare('INSERT INTO props (name, location) VALUES (?, ?)').run(name, location);
  ok(res);
});

app.put('/api/props/:name', (req, res) => {
  const name = req.params.name;
  const location = String(req.body.location || '').trim();
  if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」不存在`, 404);
  const capErr = checkInitialCapacity(location, name);
  if (capErr) return bad(res, capErr, 409);
  db.prepare('UPDATE props SET location = ? WHERE name = ?').run(location, name);
  ok(res);
});

app.delete('/api/props/:name', (req, res) => {
  const name = req.params.name;
  if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」不存在`, 404);
  // 引用该道具的转移保留，重放时会明确提示「道具不存在」，便于舞台监督核对
  db.prepare('DELETE FROM props WHERE name = ?').run(name);
  ok(res);
});

/* ---------- 提示（一组同时发生的转移） ---------- */

function validateCuePayload(body) {
  const number = Number(body.number);
  if (!Number.isInteger(number) || number <= 0)
    return { err: '提示号必须是正整数' };
  const note = String(body.note || '').trim();
  const transfers = Array.isArray(body.transfers) ? body.transfers : [];
  if (transfers.length === 0) return { err: '每组提示至少需要一条转移' };

  const seenProps = new Set();
  for (const t of transfers) {
    const prop = String(t.prop || '').trim();
    const from = String(t.from || '').trim();
    const to = String(t.to || '').trim();
    if (!prop || !from || !to) return { err: '每条转移都要选择道具、来源区位和目标区位' };
    if (from === to) return { err: `道具「${prop}」的来源与目标区位相同，不是有效转移` };
    if (seenProps.has(prop)) return { err: `道具「${prop}」在同组中最多只能转移一次` };
    seenProps.add(prop);
    if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(prop))
      return { err: `道具「${prop}」不存在` };
    if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(from))
      return { err: `来源区位「${from}」不存在` };
    if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(to))
      return { err: `目标区位「${to}」不存在` };
  }
  return { number, note, transfers: transfers.map((t) => ({
    prop: String(t.prop).trim(), from: String(t.from).trim(), to: String(t.to).trim(),
  })) };
}

app.post('/api/cues', (req, res) => {
  const v = validateCuePayload(req.body);
  if (v.err) return bad(res, v.err);
  if (db.prepare('SELECT 1 FROM cues WHERE number = ?').get(v.number))
    return bad(res, `提示号 ${v.number} 已存在，提示号必须唯一`, 409);

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO cues (number, note) VALUES (?, ?)').run(v.number, v.note);
    const ins = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const t of v.transfers) ins.run(v.number, t.prop, t.from, t.to);
  });
  tx();
  ok(res);
});

/* ---------- 试排预览（不写库） ----------
 * 沿用保存时的字段校验，把草稿按提示号插入或替换到内存中的序列，
 * 分别重放「现行序列」与「假设序列」，返回生效状态变化与最终区位变化。
 */
app.post('/api/cues/preview', (req, res) => {
  const v = validateCuePayload(req.body);
  if (v.err) return bad(res, v.err);

  const { locations, props, cues } = loadBaseData();
  const draft = { number: v.number, note: v.note, transfers: v.transfers };
  const existed = cues.some((c) => c.number === v.number);

  // 按提示号插入新提示，或整组替换同号提示（仅内存，不落库）
  const hypothetical = existed
    ? cues.map((c) => (c.number === v.number ? draft : c))
    : [...cues, draft].sort((a, b) => a.number - b.number);

  const currentReplay = replay(locations, props, cues);
  const hypotheticalReplay = replay(locations, props, hypothetical);
  const diff = diffReplays(currentReplay, hypotheticalReplay);

  res.json({
    mode: existed ? 'replace' : 'insert',
    draft,
    current: currentReplay,
    hypothetical: hypotheticalReplay,
    changedCues: diff.changedCues,
    movedProps: diff.movedProps,
  });
});

app.put('/api/cues/:number', (req, res) => {
  const number = Number(req.params.number);
  if (!db.prepare('SELECT 1 FROM cues WHERE number = ?').get(number))
    return bad(res, `提示号 ${number} 不存在`, 404);
  const v = validateCuePayload({ ...req.body, number });
  if (v.err) return bad(res, v.err);

  const tx = db.transaction(() => {
    db.prepare('UPDATE cues SET note = ? WHERE number = ?').run(v.note, number);
    db.prepare('DELETE FROM transfers WHERE cue_number = ?').run(number);
    const ins = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const t of v.transfers) ins.run(number, t.prop, t.from, t.to);
  });
  tx();
  ok(res);
});

app.delete('/api/cues/:number', (req, res) => {
  const number = Number(req.params.number);
  if (!db.prepare('SELECT 1 FROM cues WHERE number = ?').get(number))
    return bad(res, `提示号 ${number} 不存在`, 404);
  db.prepare('DELETE FROM cues WHERE number = ?').run(number); // 转移级联删除
  ok(res);
});

/* ---------- 批量平移提示号 ----------
 * 输入闭区间 [from, to] 与非零整数位移 shift，区间内每条提示号 n 改为 n + shift。
 * 校验：区间内至少一条提示；新号均为安全正整数；不与区间外提示号冲突。
 * 校验通过后在单个事务中改写提示主键与转移的提示号引用，备注、转移内容与组内顺序不变。
 */

// 共用校验：返回 { moves, conflicts } 或 { err }
function planShift(body) {
  const from = Number(body.from);
  const to = Number(body.to);
  const shift = Number(body.shift);
  if (!Number.isSafeInteger(from) || from <= 0) return { err: '起始号必须是正整数' };
  if (!Number.isSafeInteger(to) || to <= 0) return { err: '结束号必须是正整数' };
  if (from > to) return { err: `起始号 ${from} 不能大于结束号 ${to}` };
  if (!Number.isSafeInteger(shift) || shift === 0) return { err: '位移必须是非零整数' };

  const rows = db
    .prepare('SELECT number, note FROM cues WHERE number BETWEEN ? AND ? ORDER BY number')
    .all(from, to);
  if (rows.length === 0) return { err: `区间 [${from}, ${to}] 内没有任何提示，无法平移` };

  const moves = rows.map((r) => ({ from: r.number, to: r.number + shift, note: r.note }));
  for (const m of moves) {
    if (!Number.isSafeInteger(m.to) || m.to <= 0)
      return { err: `提示 ${m.from} 平移后的新号 ${m.to} 不是安全正整数，整批拒绝` };
  }

  // 新号不得与区间外的提示号冲突（区间内互撞不可能：位移是单射）
  const marks = moves.map(() => '?').join(',');
  const conflicts = db
    .prepare(
      `SELECT number FROM cues WHERE (number < ? OR number > ?) AND number IN (${marks}) ORDER BY number`
    )
    .all(from, to, ...moves.map((m) => m.to))
    .map((r) => r.number);

  return { moves, conflicts };
}

// 预览：只列出原号→新号与冲突号，不写库
app.post('/api/cues/shift/preview', (req, res) => {
  const plan = planShift(req.body);
  if (plan.err) return bad(res, plan.err);
  res.json(plan);
});

// 执行：校验通过后单事务落库，随后全量重放并返回最新状态
app.post('/api/cues/shift', (req, res) => {
  const plan = planShift(req.body);
  if (plan.err) return bad(res, plan.err);
  if (plan.conflicts.length)
    return res.status(409).json({
      error: `新号与区间外提示冲突：${plan.conflicts.join('、')}，整批已拒绝`,
      conflicts: plan.conflicts,
      moves: plan.moves,
    });

  const from = Number(req.body.from);
  const to = Number(req.body.to);
  const shift = Number(req.body.shift);

  const tx = db.transaction(() => {
    // 先取出区间内提示的完整内容（转移按 id 保序），再删旧行、按新号重写
    const trStmt = db.prepare(
      'SELECT prop, from_loc, to_loc FROM transfers WHERE cue_number = ? ORDER BY id'
    );
    const cues = db
      .prepare('SELECT number, note FROM cues WHERE number BETWEEN ? AND ? ORDER BY number')
      .all(from, to)
      .map((c) => ({ number: c.number, note: c.note, transfers: trStmt.all(c.number) }));

    db.prepare('DELETE FROM cues WHERE number BETWEEN ? AND ?').run(from, to); // 旧转移级联删除

    const insCue = db.prepare('INSERT INTO cues (number, note) VALUES (?, ?)');
    const insTr = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const c of cues) {
      const newNum = c.number + shift;
      insCue.run(newNum, c.note);
      for (const t of c.transfers) insTr.run(newNum, t.prop, t.from_loc, t.to_loc);
    }
  });
  tx();
  ok(res);
});

/* ---------- 启动 ---------- */

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`舞台换景排练系统已启动: http://localhost:${PORT}`);
});
