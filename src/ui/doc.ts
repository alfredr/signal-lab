// The lab document: a circuit plus what the UI keeps alongside it (title, notes, probes).
// Documents are immutable; every edit returns a new one, which keeps undo trivial.

import type { BlockNode, Circuit, PortRef, Wire } from "../engine/circuit.ts";
import type { ParamValue, StoredParams } from "../engine/params.ts";

export const FORMAT = "signal-lab/1";

export type ProbeView = "time" | "spectrum";

/** A signal pinned to the bench. */
export interface Probe {
  readonly id: string;
  readonly at: PortRef;
  readonly view: ProbeView;
}

export interface LabDocument extends Circuit {
  readonly format: typeof FORMAT;
  readonly title: string;
  readonly notes: string;
  readonly probes: readonly Probe[];
}

export function emptyDocument(): LabDocument {
  return { format: FORMAT, title: "Untitled", notes: "", duration: 1, blocks: [], wires: [], probes: [] };
}

export function sameRef(a: PortRef, b: PortRef): boolean {
  return a.block === b.block && a.port === b.port;
}

function nextId(prefix: string, items: readonly { readonly id: string }[]): string {
  let highest = 0;
  for (const { id } of items) {
    if (id.startsWith(prefix)) highest = Math.max(highest, Number(id.slice(prefix.length)) || 0);
  }
  return `${prefix}${highest + 1}`;
}

export function addBlock(doc: LabDocument, kind: string, x: number, y: number, params: StoredParams = {}): [LabDocument, string] {
  const id = nextId("b", doc.blocks);
  return [{ ...doc, blocks: [...doc.blocks, { id, kind, x, y, params }] }, id];
}

export function moveBlock(doc: LabDocument, id: string, x: number, y: number): LabDocument {
  return { ...doc, blocks: doc.blocks.map((block) => (block.id === id ? { ...block, x, y } : block)) };
}

export function removeBlock(doc: LabDocument, id: string): LabDocument {
  return {
    ...doc,
    blocks: doc.blocks.filter((block) => block.id !== id),
    wires: doc.wires.filter((wire) => wire.from.block !== id && wire.to.block !== id),
    probes: doc.probes.filter((probe) => probe.at.block !== id),
  };
}

export function updateBlock(doc: LabDocument, id: string, change: (block: BlockNode) => BlockNode): LabDocument {
  return { ...doc, blocks: doc.blocks.map((block) => (block.id === id ? change(block) : block)) };
}

export function setParam(doc: LabDocument, id: string, name: string, value: ParamValue): LabDocument {
  return updateBlock(doc, id, (block) => ({ ...block, params: { ...block.params, [name]: value } }));
}

export function renameBlock(doc: LabDocument, id: string, name: string): LabDocument {
  return updateBlock(doc, id, ({ name: _, ...block }) => (name.trim() ? { ...block, name: name.trim() } : block));
}

export function wireInto(doc: LabDocument, to: PortRef): Wire | undefined {
  return doc.wires.find((wire) => sameRef(wire.to, to));
}

/** Connects an output to an input, replacing whatever fed that input before. */
export function connect(doc: LabDocument, from: PortRef, to: PortRef): LabDocument {
  const existing = wireInto(doc, to);
  if (existing && sameRef(existing.from, from)) return doc;
  const wires = doc.wires.filter((wire) => wire !== existing);
  return { ...doc, wires: [...wires, { id: nextId("w", doc.wires), from, to }] };
}

export function removeWire(doc: LabDocument, id: string): LabDocument {
  return { ...doc, wires: doc.wires.filter((wire) => wire.id !== id) };
}

export function probeAt(doc: LabDocument, at: PortRef): Probe | undefined {
  return doc.probes.find((probe) => sameRef(probe.at, at));
}

export function addProbe(doc: LabDocument, at: PortRef, view: ProbeView = "time"): LabDocument {
  if (probeAt(doc, at)) return doc;
  return { ...doc, probes: [...doc.probes, { id: nextId("p", doc.probes), at, view }] };
}

export function removeProbe(doc: LabDocument, id: string): LabDocument {
  return { ...doc, probes: doc.probes.filter((probe) => probe.id !== id) };
}

export function setProbeView(doc: LabDocument, id: string, view: ProbeView): LabDocument {
  return { ...doc, probes: doc.probes.map((probe) => (probe.id === id ? { ...probe, view } : probe)) };
}

export function setSettings(doc: LabDocument, change: Partial<Pick<LabDocument, "title" | "notes" | "duration">>): LabDocument {
  return { ...doc, ...change };
}

// Reading documents back from storage or a file, trusting nothing about their shape.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readRef(value: unknown): PortRef | undefined {
  if (!isRecord(value) || !isString(value.block) || !isNumber(value.port)) return undefined;
  return { block: value.block, port: Math.trunc(value.port) };
}

function readParams(value: unknown): StoredParams {
  if (!isRecord(value)) return {};
  const params: Record<string, ParamValue> = {};
  for (const [name, v] of Object.entries(value)) {
    if (isString(v) || isNumber(v) || typeof v === "boolean") params[name] = v;
  }
  return params;
}

/** Validates a parsed JSON value as a document. Throws with a readable message if it isn't one. */
export function readDocument(value: unknown): LabDocument {
  if (!isRecord(value) || value.format !== FORMAT) throw new Error("This file isn't a Signal Lab diagram.");
  const blocks: BlockNode[] = [];
  for (const b of Array.isArray(value.blocks) ? value.blocks : []) {
    if (!isRecord(b) || !isString(b.id) || !isString(b.kind) || !isNumber(b.x) || !isNumber(b.y)) continue;
    blocks.push({ id: b.id, kind: b.kind, x: b.x, y: b.y, params: readParams(b.params), ...(isString(b.name) && b.name ? { name: b.name } : {}) });
  }
  const ids = new Set(blocks.map((block) => block.id));
  const wires: Wire[] = [];
  for (const w of Array.isArray(value.wires) ? value.wires : []) {
    if (!isRecord(w) || !isString(w.id)) continue;
    const from = readRef(w.from);
    const to = readRef(w.to);
    if (from && to && ids.has(from.block) && ids.has(to.block)) wires.push({ id: w.id, from, to });
  }
  const probes: Probe[] = [];
  for (const p of Array.isArray(value.probes) ? value.probes : []) {
    if (!isRecord(p) || !isString(p.id)) continue;
    const at = readRef(p.at);
    if (at && ids.has(at.block)) probes.push({ id: p.id, at, view: p.view === "spectrum" ? "spectrum" : "time" });
  }
  return {
    format: FORMAT,
    title: isString(value.title) ? value.title : "Untitled",
    notes: isString(value.notes) ? value.notes : "",
    duration: isNumber(value.duration) && value.duration > 0 ? value.duration : 1,
    blocks,
    wires,
    probes,
  };
}
