import { visiblePorts } from '../engine/block.ts';
import type { PortRef } from '../engine/circuit.ts';
import { si } from '../engine/format.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import { blockAt, type LabDocument } from '../model/document.ts';
import { displayName, typeOf } from '../model/subsystems.ts';

/**
 * A readable name for a port anywhere in the document: the blocks along its
 * path, then the port's own name if the block has more than one. "Station A ›
 * Modulator", "Phase splitter Q".
 */
export function portLabel(
  doc: LabDocument,
  ref: PortRef,
  direction: 'in' | 'out' = 'out',
): string {
  const block = blockAt(doc, ref.block);
  const type = block && typeOf(block);
  const ports = (direction === 'out' ? type?.outputs : type?.inputs) ?? [];
  const port =
    visiblePorts(ports).length > 1
      ? ` ${ports[ref.port]?.name ?? ref.port}`
      : '';
  return `${blockLabel(doc, ref.block)}${port}`;
}

/** The names of the blocks along a full id: "Station A › Modulator". */
export function blockLabel(doc: LabDocument, fullId: string): string {
  const parts = fullId.split('/');
  return parts
    .map((_, i) => {
      const block = blockAt(doc, parts.slice(0, i + 1).join('/'));
      return block ? displayName(block) : '?';
    })
    .join(' › ');
}

/** An output's sample rate for display, if it has a signal. */
export function rateLabel(
  status: BlockStatus | undefined,
  port: number,
): string | undefined {
  const rate = status?.state === 'ok' ? status.rates[port] : undefined;
  return rate !== undefined && Number.isFinite(rate)
    ? si(rate, 'Hz')
    : undefined;
}
