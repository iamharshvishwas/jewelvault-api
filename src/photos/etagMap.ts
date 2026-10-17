// A13 (API17): the map of the last 5,000 (photo id, kind) to sha256. Every photo answer carries the sha256 as its ETag; the process keeps this map, filled on each read and emptied for a photo when it is
// removed, so that a repeated read with If-None-Match is answered 304 WITHOUT A DATABASE READ for any photo seen since the process started. It restarts empty with the process ("that is accepted"), and
// then a photo not yet seen costs one read of its sha256 (never of its bytes).
//
// The map is least-recently-used: a read counts as a use, and the 5,001st entry pushes out the one used longest ago.
//
// A REMOVED PHOTO IS NEVER 304. Emptying the map at removal is not enough on its own: a read that found the photo alive, then waited while the owner removed it, would put the sha256 back after the
// removal had emptied the map. So a reader takes a token with begin() before it reads, and set() refuses the entry when a removal (drop) or a clear has happened since: the entry of a photo that was
// read before its removal never lands.
import { PHOTO_KINDS } from './photoStore.js';

export class EtagMap {
  private readonly entries = new Map<string, string>();
  /** moves on at every removal and clear; a token from before is stale */
  private generation = 0;

  constructor(readonly maxEntries: number = 5000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('the ETag map holds a whole number of entries, at least 1');
  }

  get size(): number {
    return this.entries.size;
  }

  private static key(photoId: string, kind: string): string {
    return `${photoId}/${kind}`;
  }

  /** The sha256 (hex) held for the object, or undefined. A hit makes the entry the newest. */
  get(photoId: string, kind: string): string | undefined {
    const key = EtagMap.key(photoId, kind);
    const sha = this.entries.get(key);
    if (sha !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, sha);
    }
    return sha;
  }

  /** Call BEFORE reading a photo, and hand the token to set(). */
  begin(): number {
    return this.generation;
  }

  /** Keeps the sha256 of an object unless a removal or a clear has happened since `token` was taken. Returns whether it was kept. */
  set(token: number, photoId: string, kind: string, sha256: string): boolean {
    if (token !== this.generation) return false;
    const key = EtagMap.key(photoId, kind);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, sha256);
    return true;
  }

  /** A photo was removed: both kinds leave the map, and every read that began before now will not be kept. */
  drop(photoId: string): void {
    this.generation++;
    for (const kind of PHOTO_KINDS) this.entries.delete(EtagMap.key(photoId, kind));
  }

  /** The state of a process that has just started. */
  clear(): void {
    this.generation++;
    this.entries.clear();
  }
}
