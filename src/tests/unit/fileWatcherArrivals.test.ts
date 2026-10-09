/**
 * The watcher's record of paths that arrived (an event first saw them holding
 * a file where none was known, and nothing paired with them), asked whether a
 * note the walk finds gone may have moved to one: only when it arrived after
 * the note was last seen.
 */
import { describe, it, expect } from 'vitest';
import { Arrivals } from '../../main/services/fileWatcherArrivals';
import { vaultPath } from '../../shared/vaultPath';

const OLD = 'Places/Castle.md';
const NEW = '04 Worldbuilding/Castle.md';
const k = vaultPath;

/** The old note last recorded by a walk at `recordedAt`, found gone by the next one. */
function goneAfterWalk(a: Arrivals, recordedAt: number): void {
  a.walkFoundGone(k(OLD), recordedAt);
}

describe('Arrivals', () => {
  it('a path that arrived after the walk last recorded the note may be the note moved', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), false, 2000);
    goneAfterWalk(a, 1000);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(true);
    // Compared case-folded, as Windows names files.
    expect(a.arrivedSinceLastSeen(NEW.toUpperCase(), OLD.toLowerCase())).toBe(true);
  });

  it('a path already known when an event saw it is no arrival', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), true, 2000);
    goneAfterWalk(a, 1000);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
  });

  it('a path that arrived before the note was last recorded is not it', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), false, 1000);
    goneAfterWalk(a, 2000);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
  });

  it('an event or Filo\'s own write that saw the note after the arrival rules it out', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), false, 2000);
    a.sawPresent(k(OLD), true, 3000);
    goneAfterWalk(a, 1000);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);

    const b = new Arrivals();
    b.sawPresent(k(NEW), false, 2000);
    b.written(k(OLD), 3000);
    goneAfterWalk(b, 1000);
    expect(b.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
  });

  it('only a note the walk found gone is asked about', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), false, 2000);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
  });

  it('a path the walk found new arrived at that walk: a note the same walk recorded is not it', () => {
    const a = new Arrivals();
    a.walkFoundNew(k(NEW), 1000);
    goneAfterWalk(a, 1000);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
    // An event that saw it first keeps that earlier, live time.
    const b = new Arrivals();
    b.sawPresent(k(NEW), false, 1500);
    b.walkFoundNew(k(NEW), 3000);
    goneAfterWalk(b, 1000);
    expect(b.arrivedSinceLastSeen(NEW, OLD)).toBe(true);
  });

  it('a walk recording the path again, Filo writing it, or it going, ends the arrival', () => {
    for (const end of [
      (a: Arrivals) => a.walked(k(NEW), 2500),
      (a: Arrivals) => a.written(k(NEW), 2500),
      (a: Arrivals) => a.sawGone(k(NEW)),
      (a: Arrivals) => a.forgetUnder('04 Worldbuilding'),
      (a: Arrivals) => a.paired(k('Elsewhere/Castle.md'), k(NEW)),
    ]) {
      const a = new Arrivals();
      a.sawPresent(k(NEW), false, 2000);
      end(a);
      goneAfterWalk(a, 1000);
      expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
    }
  });

  it('once the note\'s event is sent or paired, the walk\'s record of it is no longer asked about', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), false, 2000);
    goneAfterWalk(a, 1000);
    a.sent(k(OLD));
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
  });

  it('a move carries arrivals and sightings with it', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), false, 2000);
    a.move('04 Worldbuilding', '05 Places');
    goneAfterWalk(a, 1000);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
    expect(a.arrivedSinceLastSeen('05 Places/Castle.md', OLD)).toBe(true);
  });

  it('clear forgets everything', () => {
    const a = new Arrivals();
    a.sawPresent(k(NEW), false, 2000);
    goneAfterWalk(a, 1000);
    a.clear();
    expect(a.any()).toBe(false);
    expect(a.arrivedSinceLastSeen(NEW, OLD)).toBe(false);
  });
});
