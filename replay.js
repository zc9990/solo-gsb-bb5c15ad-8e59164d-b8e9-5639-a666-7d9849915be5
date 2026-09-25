'use strict';

/**
 * 全量重放：从道具初始区位出发，按提示号升序逐组校验并应用转移。
 *
 * 规则：
 *  - 每组转移基于「该组变动前」的状态校验来源区位；
 *  - 同组内每件道具最多转移一次；
 *  - 整组应用后，除「后台」外任一区位不得被多件道具占用（允许同组互换）；
 *  - 任一条校验失败则整组不生效，状态保持变动前，并记录全部冲突原因。
 *
 * 冲突溯源（trace，随每组结果返回）：
 *  - 维护「道具 -> 最后一次成功转移它的提示号」，仅在某组整组生效后按提示号顺序更新，
 *    失败组既不改变位置也不改变溯源；null 表示从未成功转移（现处初始区位）；
 *  - 来源区位不符：记录道具当前区位与最后一次成功转移的提示号；
 *  - 容量冲突：记录试算后同占该区位的全部道具，标明是否由本组转入，
 *    以及各道具此前（组前状态）最后一次成功转移的提示号。
 *
 * @param {Array<{name:string, unlimited:boolean}>} locations
 * @param {Array<{name:string, location:string}>}   props
 * @param {Array<{number:number, note:string, transfers:Array<{prop:string, from:string, to:string}>}>} cues 已按提示号升序
 * @returns {{results: Array, finalState: Object<string,string>, finalLocations: Object<string,string[]>}}
 *   results 元素：{number, note, ok, errors, transfers,
 *     trace: {sourceMismatches: Array<{prop, from, current, lastMovedCue}>,
 *             capacityConflicts: Array<{location, occupants: Array<{prop, movedIn, lastMovedCue}>}>}}
 */
function replay(locations, props, cues) {
  const locDef = new Map(locations.map((l) => [l.name, l]));

  // 当前状态：道具 -> 区位（从初始区位开始）
  const state = {};
  for (const p of props) state[p.name] = p.location;

  // 溯源：道具 -> 最后一次成功转移它的提示号（null = 从未成功转移，现处初始区位）
  const lastMoved = {};
  for (const p of props) lastMoved[p.name] = null;

  const results = [];

  for (const cue of cues) {
    const errors = [];
    // 结构化冲突溯源：随结果返回，供失败提示旁展示（成功组恒为空）
    const trace = { sourceMismatches: [], capacityConflicts: [] };

    // 1) 同组内同一道具不得出现多次（数据库有唯一约束，这里兜底防御）
    const seen = new Set();
    for (const t of cue.transfers) {
      if (seen.has(t.prop)) errors.push(`道具「${t.prop}」在本组中被转移多次`);
      seen.add(t.prop);
    }

    // 2) 基于变动前状态校验来源
    for (const t of cue.transfers) {
      if (!(t.prop in state)) {
        errors.push(`道具「${t.prop}」不存在`);
      } else if (state[t.prop] !== t.from) {
        errors.push(`道具「${t.prop}」当前位于「${state[t.prop]}」，不在来源区位「${t.from}」`);
        // 溯源：当前区位 + 最后一次成功转移的提示号（null = 初始区位）
        trace.sourceMismatches.push({
          prop: t.prop,
          from: t.from,
          current: state[t.prop],
          lastMovedCue: lastMoved[t.prop],
        });
      }
      if (!locDef.has(t.to)) {
        errors.push(`目标区位「${t.to}」不存在`);
      }
    }

    // 3) 试算整组完成后的占用情况（来源校验通过才有意义）
    let next = null;
    if (errors.length === 0) {
      next = { ...state };
      for (const t of cue.transfers) next[t.prop] = t.to;

      const occupancy = new Map(); // 区位 -> [道具]
      for (const [prop, loc] of Object.entries(next)) {
        if (!occupancy.has(loc)) occupancy.set(loc, []);
        occupancy.get(loc).push(prop);
      }
      for (const [loc, occupants] of occupancy) {
        const def = locDef.get(loc);
        if (def && !def.unlimited && occupants.length > 1) {
          errors.push(
            `区位「${loc}」容量为一件，本组完成后将被 ${occupants.map((p) => `「${p}」`).join('、')} 同时占用`
          );
          // 溯源：试算后同占该区位的道具，标明是否由本组转入 + 此前最后一次成功转移的提示号
          const movedIn = new Set(
            cue.transfers.filter((t) => t.to === loc).map((t) => t.prop)
          );
          trace.capacityConflicts.push({
            location: loc,
            occupants: occupants.map((p) => ({
              prop: p,
              movedIn: movedIn.has(p),
              lastMovedCue: lastMoved[p] !== undefined ? lastMoved[p] : null,
            })),
          });
        }
      }
    }

    if (errors.length === 0 && next) {
      // 整组通过才提交：位置与溯源一并按提示号顺序更新
      Object.assign(state, next);
      for (const t of cue.transfers) lastMoved[t.prop] = cue.number;
      results.push({ number: cue.number, note: cue.note, ok: true, errors: [], transfers: cue.transfers, trace });
    } else {
      // 整组不生效，状态与溯源一并回滚（保持变动前）
      results.push({ number: cue.number, note: cue.note, ok: false, errors, transfers: cue.transfers, trace });
    }
  }

  // 汇总最终区位：区位 -> [道具]
  const finalLocations = {};
  for (const l of locations) finalLocations[l.name] = [];
  for (const [prop, loc] of Object.entries(state)) {
    if (!finalLocations[loc]) finalLocations[loc] = [];
    finalLocations[loc].push(prop);
  }

  return { results, finalState: state, finalLocations };
}

/**
 * 对比两次重放的结果（用于「试排预览」：现行序列 vs 草稿插入/替换后的假设序列）。
 *
 *  - changedCues：按提示号列出「生效状态」发生变化的提示（含新增），携带前后冲突原因；
 *  - movedProps：最终区位发生变化的道具（from/to 为 null 表示道具在该序列中不存在）。
 *
 * @param {ReturnType<replay>} before 现行序列重放结果
 * @param {ReturnType<replay>} after  假设序列重放结果
 */
function diffReplays(before, after) {
  const beforeBy = new Map(before.results.map((r) => [r.number, r]));
  const afterBy = new Map(after.results.map((r) => [r.number, r]));
  const numbers = new Set([...beforeBy.keys(), ...afterBy.keys()]);

  const changedCues = [];
  for (const number of numbers) {
    const b = beforeBy.get(number) || null;
    const a = afterBy.get(number) || null;
    // 新增（一边不存在）或 ok 状态翻转，都算生效状态变化
    if (!b || !a || b.ok !== a.ok) {
      changedCues.push({
        number,
        note: (a || b).note,
        before: b ? { ok: b.ok, errors: b.errors } : null,
        after: a ? { ok: a.ok, errors: a.errors } : null,
      });
    }
  }
  changedCues.sort((x, y) => x.number - y.number);

  const movedProps = [];
  const allProps = new Set([
    ...Object.keys(before.finalState),
    ...Object.keys(after.finalState),
  ]);
  for (const prop of allProps) {
    const from = before.finalState[prop];
    const to = after.finalState[prop];
    if (from !== to) movedProps.push({ prop, from: from || null, to: to || null });
  }

  return { changedCues, movedProps };
}

module.exports = { replay, diffReplays };
