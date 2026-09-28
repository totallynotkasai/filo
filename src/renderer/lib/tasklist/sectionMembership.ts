/**
 * A Task List's structure as "which section each task is in, in what order",
 * rather than absolute indices. Section starts are absolute indices into the
 * flat `tasks` array, so an undo that puts back recorded starts (or a whole
 * `tasks` array) undoes, or misplaces, whatever another change did to the
 * board in between: a card removed by a cascade, a task added from another
 * view. Recording the move instead (the tasks that moved, and where they sat
 * relative to their neighbours) and recomputing the starts from the live
 * order leaves every other task where it is now.
 *
 * Pure: no store access.
 */
import type { TaskListSection, TaskPlacement } from '../../schema/index';

/** A section id, or null for the rows above the first section. */
export type SectionKey = string | null;

/** The order of the tasks and the section each is in. */
export interface TaskLayout {
  order: string[];
  sectionOf: Record<string, SectionKey>;
}

/** Sections in the order that decides ownership: by start, ties in array order. */
function sortedSections(sections: TaskListSection[]): TaskListSection[] {
  return [...sections].sort((a, b) => a.position - b.position);
}

/**
 * Where each task sits. Among sections tied at one start, the last owns the
 * rows (the earlier ones are empty), as the view and `sectionMath` read it.
 */
export function layoutOf(sections: TaskListSection[], tasks: TaskPlacement[]): TaskLayout {
  const sorted = sortedSections(sections);
  const sectionOf: Record<string, SectionKey> = {};
  let s = -1;
  tasks.forEach((p, i) => {
    while (s + 1 < sorted.length && (sorted[s + 1]?.position ?? Infinity) <= i) s++;
    sectionOf[p.tileId] = s >= 0 ? (sorted[s]?.id ?? null) : null;
  });
  return { order: tasks.map((p) => p.tileId), sectionOf };
}

/**
 * `tasks` grouped into their sections (`sectionOf`, falling back to where
 * each sits now), keeping their relative order, with every section's start
 * recomputed. A task whose section no longer exists stays in the one it sits
 * in now.
 */
export function regroup(
  sections: TaskListSection[],
  tasks: TaskPlacement[],
  sectionOf: Readonly<Record<string, SectionKey>>,
): { sections: TaskListSection[]; tasks: TaskPlacement[] } {
  const sorted = sortedSections(sections);
  const live = new Set(sorted.map((s) => s.id));
  const now = layoutOf(sections, tasks).sectionOf;
  const buckets = new Map<SectionKey, TaskPlacement[]>([[null, []]]);
  for (const s of sorted) buckets.set(s.id, []);
  for (const p of tasks) {
    const wanted = Object.prototype.hasOwnProperty.call(sectionOf, p.tileId) ? sectionOf[p.tileId] ?? null : undefined;
    const key = wanted !== undefined && (wanted === null || live.has(wanted)) ? wanted : (now[p.tileId] ?? null);
    buckets.get(key)?.push(p);
  }
  const outTasks: TaskPlacement[] = [...(buckets.get(null) ?? [])];
  const outSections: TaskListSection[] = [];
  for (const s of sorted) {
    outSections.push({ ...s, position: outTasks.length });
    outTasks.push(...(buckets.get(s.id) ?? []));
  }
  return { sections: outSections, tasks: outTasks.map((p, i) => ({ ...p, position: i })) };
}

/**
 * The most ids of `b` that appear in the same order in `a` (two orderings of
 * the same ids): a longest increasing run of their `a` indices, found in
 * n log n so a long list costs no more than a short one.
 */
function commonOrder(a: string[], b: string[]): Set<string> {
  const indexInA = new Map(a.map((id, i) => [id, i]));
  const seq = b.map((id) => indexInA.get(id) ?? -1);
  // tails[k]: index into seq of the smallest tail of a run of length k + 1.
  const tails: number[] = [];
  const prev: number[] = new Array<number>(seq.length).fill(-1);
  seq.forEach((v, i) => {
    if (v < 0) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] ?? 0] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] ?? -1;
    tails[lo] = i;
  });
  const kept = new Set<string>();
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = prev[i] ?? -1) {
    const id = b[i];
    if (id !== undefined) kept.add(id);
  }
  return kept;
}

/**
 * The tasks a structural change moved from `before` to `after`: those that
 * changed section, plus the fewest that must have moved inside a section for
 * its order to change. Every other task kept its section and its order
 * relative to the rest.
 */
export function movedTasks(before: TaskLayout, after: TaskLayout): string[] {
  const moved = new Set<string>();
  const inAfter = new Set(after.order);
  for (const id of before.order) {
    if (!inAfter.has(id) || before.sectionOf[id] !== after.sectionOf[id]) moved.add(id);
  }
  for (const id of after.order) if (!(id in before.sectionOf)) moved.add(id);
  const sections = new Set<SectionKey>(Object.values(after.sectionOf));
  for (const section of sections) {
    const a = before.order.filter((id) => !moved.has(id) && before.sectionOf[id] === section);
    const b = after.order.filter((id) => !moved.has(id) && after.sectionOf[id] === section);
    const kept = commonOrder(a, b);
    for (const id of a) if (!kept.has(id)) moved.add(id);
  }
  return after.order.filter((id) => moved.has(id));
}

/**
 * Puts `moved` where `target` has them, on the board as it is now: each goes
 * right after the task before it in `target`'s section (or first in that
 * section when none of those is still there). A moved task no longer on the
 * board stays gone; one whose target section is gone stays where it is. No
 * other task changes section or order.
 */
export function applyMove(
  sections: TaskListSection[],
  tasks: TaskPlacement[],
  moved: readonly string[],
  target: TaskLayout,
): { sections: TaskListSection[]; tasks: TaskPlacement[] } {
  const liveSections = new Set(sections.map((s) => s.id));
  const sectionOf: Record<string, SectionKey> = { ...layoutOf(sections, tasks).sectionOf };
  const byId = new Map(tasks.map((p) => [p.tileId, p]));
  const moving = new Set(
    moved.filter((id) => {
      const to = target.sectionOf[id];
      return byId.has(id) && to !== undefined && (to === null || liveSections.has(to));
    }),
  );
  const work: TaskPlacement[] = tasks.filter((p) => !moving.has(p.tileId));
  for (const id of target.order) {
    if (!moving.has(id)) continue;
    const to = target.sectionOf[id] ?? null;
    const placement = byId.get(id);
    if (!placement) continue;
    // The nearest earlier task of the same target section still on the board.
    const at = target.order.indexOf(id);
    let insertAt = -1;
    for (let k = at - 1; k >= 0; k--) {
      const prev = target.order[k]!;
      if ((target.sectionOf[prev] ?? null) !== to) continue;
      const idx = work.findIndex((p) => p.tileId === prev);
      if (idx >= 0 && sectionOf[prev] === to) {
        insertAt = idx + 1;
        break;
      }
    }
    if (insertAt < 0) {
      const first = work.findIndex((p) => sectionOf[p.tileId] === to);
      insertAt = first >= 0 ? first : work.length;
    }
    work.splice(insertAt, 0, placement);
    sectionOf[id] = to;
  }
  return regroup(sections, work, sectionOf);
}
