/** `sync.mjs` 的类型声明（导出/导入：多设备共用记忆）。 */

export const BUNDLE_FORMAT: string;
export const BUNDLE_VERSION: number;

export interface BundleDevice {
	id: string;
	name: string;
}

export interface BundleEntry {
	target: "memory" | "user" | "standing" | "failure";
	scope: "global" | "project";
	projectKey: string;
	content: string;
	category?: string;
}

export interface BundleTombstone {
	key: string;
	target: string;
	scope: string;
	projectKey: string;
	at: string;
}

export interface MemoryBundle {
	format: string;
	version: number;
	exportedAt: string;
	device: BundleDevice;
	entries: BundleEntry[];
	tombstones: BundleTombstone[];
}

export interface MergeOutcome {
	added: number;
	duplicate: number;
	tombstoned: number;
	rejected: number;
	removed: number;
	scopes: string[];
	device: string;
}

export function readDeviceProfile(root: string): BundleDevice;
export function deviceScopeId(root: string): string;
export function readTombstones(root: string): BundleTombstone[];
export function addTombstone(root: string, input: { target: string; scope: string; projectKey?: string; content: string; at?: string }): void;
export function listSharedScopes(root: string): { target: string; scope: string; projectId: string }[];
export function buildExportBundle(root: string, options?: { exportedAt?: string }): MemoryBundle;
export function serializeBundle(bundle: MemoryBundle): string;
export function validateBundle(value: unknown): MemoryBundle;
export function mergeBundle(root: string, value: unknown, options?: { localDeviceKey?: string }): MergeOutcome;
export function countBundleEntries(value: unknown): { entries: number; device: string; exportedAt: string };
