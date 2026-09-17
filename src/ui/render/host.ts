/**
 * A React host that produces `Line[]` instead of a string.
 *
 * Modelled on `ink/build/reconciler.js` rather than on documentation: the host
 * config's shape is specific to react-reconciler 0.33 with React 19, and the
 * version that ships inside Ink is the one known to work against the React we
 * have.
 *
 * Two node types, because the UI uses two. `Stack` is only ever given a
 * direction and a horizontal pad, so there is no constraint solver here and no
 * Yoga -- the layout is "stack rows" and "concatenate spans", which is what a
 * line-shaped UI actually needs.
 *
 * `Static` has no counterpart on purpose. Ink needs it because a printed line
 * is gone; here the grid holds every row and the renderer simply declines to
 * address the ones that have scrolled out of the viewport, so settled output
 * reaches the terminal's scrollback without a separate append-only channel.
 */

import createReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants.js";
import { createContext } from "react";
import type { Line, Span } from "../layout.ts";

type Style = {
  color?: string;
  bg?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
};

export type TextNode = { kind: "text"; style: Style; children: Node[] };
export type StringNode = { kind: "string"; text: string };
export type BoxNode = {
  kind: "box";
  direction: "row" | "column";
  padX: number;
  children: Node[];
};
export type Node = TextNode | StringNode | BoxNode;

export type Root = {
  kind: "box";
  direction: "column";
  padX: 0;
  children: Node[];
  onRender?: () => void;
};

export function createRoot(): Root {
  return { kind: "box", direction: "column", padX: 0, children: [], onRender: undefined };
}

function spansOf(n: Node, inherited: Style): Span[] {
  if (n.kind === "string") {
    return n.text === "" ? [] : [{ text: n.text, ...inherited }];
  }
  if (n.kind === "box") return rowsOf(n)[0] ?? [];
  const style: Style = { ...inherited, ...strip(n.style) };
  return n.children.flatMap((c) => spansOf(c, style));
}

/** An undefined prop must not shadow an inherited one. */
function strip(s: Style): Style {
  const out: Style = {};
  if (s.color !== undefined) out.color = s.color;
  if (s.bg !== undefined) out.bg = s.bg;
  if (s.dim !== undefined) out.dim = s.dim;
  if (s.bold !== undefined) out.bold = s.bold;
  if (s.italic !== undefined) out.italic = s.italic;
  return out;
}

function rowsOf(n: Node): Span[][] {
  if (n.kind === "string") return [[{ text: n.text }]];
  if (n.kind === "text") return [spansOf(n, {})];

  const kids = n.children.map(rowsOf);
  let rows: Span[][];
  if (n.direction === "row") {
    const height = kids.reduce((h, k) => Math.max(h, k.length), 0);
    rows = Array.from({ length: height }, (_, i) => kids.flatMap((k) => k[i] ?? []));
  } else {
    rows = kids.flat();
  }

  if (n.padX > 0) {
    const pad: Span = { text: " ".repeat(n.padX) };
    rows = rows.map((r) => [pad, ...r]);
  }
  return rows;
}

export function toLines(root: Root): Line[] {
  return rowsOf(root).map((spans) => ({
    text: spans.map((s) => s.text).join(""),
    spans,
  }));
}

function nodeFor(type: string, props: Record<string, unknown>): Node {
  if (type === "tui-box") {
    return {
      kind: "box",
      direction: props["direction"] === "row" ? "row" : "column",
      padX: typeof props["padX"] === "number" ? props["padX"] : 0,
      children: [],
    };
  }
  return { kind: "text", style: styleFrom(props), children: [] };
}

function styleFrom(props: Record<string, unknown>): Style {
  const s: Style = {};
  if (typeof props["color"] === "string") s.color = props["color"];
  if (typeof props["bg"] === "string") s.bg = props["bg"];
  if (typeof props["dim"] === "boolean") s.dim = props["dim"];
  if (typeof props["bold"] === "boolean") s.bold = props["bold"];
  if (typeof props["italic"] === "boolean") s.italic = props["italic"];
  return s;
}

function detach(parent: { children: Node[] }, child: Node): void {
  const i = parent.children.indexOf(child);
  if (i !== -1) parent.children.splice(i, 1);
}

let updatePriority: number = NoEventPriority;

export const reconciler = createReconciler({
  // React asserts on a null host context, so this is an object even though
  // nothing here is context-dependent.
  getRootHostContext: () => ({}),
  getChildHostContext: (parent: unknown) => parent,
  prepareForCommit: () => null,
  preparePortalMount: () => {},
  clearContainer: () => false,
  resetAfterCommit(root: Root) {
    root.onRender?.();
  },

  shouldSetTextContent: () => false,
  createInstance: (type: string, props: Record<string, unknown>) => nodeFor(type, props),
  createTextInstance: (text: string): StringNode => ({ kind: "string", text }),
  getPublicInstance: (i: unknown) => i,
  finalizeInitialChildren: () => false,

  appendInitialChild: (parent: BoxNode | TextNode, child: Node) => {
    parent.children.push(child);
  },
  appendChild: (parent: BoxNode | TextNode, child: Node) => {
    detach(parent, child);
    parent.children.push(child);
  },
  appendChildToContainer: (root: Root, child: Node) => {
    detach(root, child);
    root.children.push(child);
  },
  insertBefore: (parent: BoxNode | TextNode, child: Node, before: Node) => {
    detach(parent, child);
    parent.children.splice(parent.children.indexOf(before), 0, child);
  },
  insertInContainerBefore: (root: Root, child: Node, before: Node) => {
    detach(root, child);
    root.children.splice(root.children.indexOf(before), 0, child);
  },
  removeChild: (parent: BoxNode | TextNode, child: Node) => detach(parent, child),
  removeChildFromContainer: (root: Root, child: Node) => detach(root, child),

  commitUpdate(node: Node, _type: string, _old: unknown, props: Record<string, unknown>) {
    if (node.kind === "text") node.style = styleFrom(props);
    else if (node.kind === "box") {
      node.direction = props["direction"] === "row" ? "row" : "column";
      node.padX = typeof props["padX"] === "number" ? props["padX"] : 0;
    }
  },
  commitTextUpdate(node: StringNode, _old: string, text: string) {
    node.text = text;
  },
  resetTextContent: () => {},
  hideInstance: () => {},
  unhideInstance: () => {},
  hideTextInstance: (node: StringNode) => {
    node.text = "";
  },
  unhideTextInstance: (node: StringNode, text: string) => {
    node.text = text;
  },

  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1 as const,

  setCurrentUpdatePriority(p: number) {
    updatePriority = p;
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () =>
    updatePriority !== NoEventPriority ? updatePriority : DefaultEventPriority,

  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  detachDeletedInstance: () => {},
  getInstanceFromNode: () => null,
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  resetFormInstance: () => {},
  NotPendingTransition: undefined,
  HostTransitionContext: createContext(null),
  rendererPackageName: "tui-cells",
  rendererVersion: "0.1.0",
});
