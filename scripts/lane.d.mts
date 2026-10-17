import type { Connection } from 'mysql2/promise';
export type Lane = 'main' | 'a' | 'b' | 'c';
export interface LaneOptions {
  /** Letters and digits: containers are jv-mariadb-<namespace>-<lane>. For the harness's own tests only. */
  namespace?: string;
  /** Port of lane main; the others add 1, 2, 3. Default 33310. */
  portBase?: number;
}
export interface LaneReady {
  lane: Lane;
  name: string;
  host: string;
  port: number;
  database: string;
  appUser: string;
  running: boolean;
}
/** With the generated passwords. Never print it or write it to a file. */
export interface LaneInfo extends LaneReady {
  appPassword: string;
  rootPassword: string;
}
export const LANES: Lane[];
export const LANE_DATABASE: string;
export const LANE_USER: string;
export const HOSTINGER_SQL_MODE: string;
/** The ten ticked boxes of A3. */
export const TEN_BOXES: string[];
export function laneInfo(lane: Lane, opts?: LaneOptions): Promise<LaneInfo | null>;
export function laneEnv(lane: Lane, opts?: LaneOptions): Record<string, string>;
export function selectedLane(): Lane | null;
export function createTenBoxUser(root: Connection, o: { database: string; user: string; password: string }): Promise<void>;
export function laneUp(lane: Lane, opts?: LaneOptions): Promise<Omit<LaneReady, 'running'> & { running?: boolean }>;
export function laneDown(lane: Lane, opts?: LaneOptions): Promise<boolean>;
export function laneReset(lane: Lane, opts?: LaneOptions): Promise<Omit<LaneReady, 'running'> & { running?: boolean }>;
export function laneUrl(lane: Lane, opts?: LaneOptions): Promise<string>;
