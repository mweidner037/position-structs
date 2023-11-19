import { Node, NodeDesc } from "./node";
import { Order } from "./order";
import { Position } from "./position";
import { SparseArray } from "./sparse_array";

/**
 * List data associated to a Node.
 */
type NodeData<T> = {
  /**
   * The total number of present values at this
   * node and its descendants.
   */
  total: number;
  /**
   * The values at the node's positions,
   * in order from left to right.
   */
  values: SparseArray<T>;
};

/**
 * Type used in LocalList.slicesAndChildren.
 *
 * Either a slice of values in a Node that are also contiguous in the list order,
 * or a non-empty Node child.
 */
type SliceOrChild<T> =
  | {
      type: "slice";
      /** Use item.slice(start, end) */
      values: T[];
      start: number;
      end: number;
      /** valueIndex of first value */
      valueIndex: number;
    }
  | {
      type: "child";
      child: Node;
      /** Always non-zero (zero total children are skipped). */
      total: number;
    };

/**
 * TODO: Explain format (obvious triple-map rep). JSON ordering guarantees.
 */
export type ListSavedState<T> = {
  [creatorID: string]: {
    [timestamp: number]: {
      [valueIndex: number]: T;
    };
  };
};

/**
 * A local (non-collaborative) data structure mapping [[Position]]s to
 * values, in list order.
 *
 * You can use a LocalList to maintain a sorted, indexable view of a
 * [[CValueList]], [[CList]], or [[CText]]'s values.
 * For example, when using a [[CList]],
 * you could store its archived values in a LocalList.
 * That would let you iterate over the archived values in list order.
 *
 * To construct a LocalList that uses an existing list's positions, pass
 * that list's `totalOrder` to our constructor.
 *
 * It is *not* safe to modify a LocalList while iterating over it. The iterator
 * will attempt to throw an exception if it detects such modification,
 * but this is not guaranteed.
 *
 * @typeParam T The value type.
 */
export class List<T> {
  /**
   * Map from Node to its data (total & values).
   *
   * Always omits entries with total = 0.
   */
  private state = new Map<Node, NodeData<T>>();

  /**
   * Constructs a LocalList whose allowed [[Position]]s are given by
   * `source`.
   *
   * Using positions that were not generated by `source` (or a replica of
   * `source`) will cause undefined behavior.
   *
   * @param order The source for positions that may be used with this
   * LocalList.
   */
  constructor(readonly order: Order) {}

  // ----------
  // Mutators
  // ----------

  /**
   * Sets the value at `pos`.
   *
   * @throws TODO pos invalid
   */
  set(pos: Position, value: T): void;
  /**
   * TODO
   *
   * If multiple values are given, they are set starting at startPos
   * in the same Node. Note these might not be contiguous anymore,
   * unless they are new (no causally-future Positions set yet).
   * @param startPos
   * @param sameNodeValues
   */
  set(startPos: Position, ...sameNodeValues: T[]): void;
  set(startPos: Position, ...values: T[]): void {
    // Validate startPos even if values.length = 0.
    const node = this.order.getNodeFor(startPos);
    if (values.length === 0) return;
    if (
      node === this.order.rootNode &&
      startPos.valueIndex + values.length - 1 > 1
    ) {
      throw new Error(
        `Last value's Position is invalid (rootNode only allows valueIndex 0 or 1): startPos=${JSON.stringify(
          startPos
        )}, values.length=${values.length}`
      );
    }

    let data = this.state.get(node);
    if (data === undefined) {
      data = { total: 0, values: SparseArray.new() };
      this.state.set(node, data);
    }

    const existing = data.values.set(startPos.valueIndex, values);
    this.onUpdate(node, values.length - existing.size);
  }

  /**
   * Sets the value at index.
   *
   * @throws If index is not in `[0, this.length)`.
   */
  setAt(index: number, value: T): void {
    this.set(this.positionAt(index), value);
  }

  /**
   * Deletes the given position, making it no longer
   * present in this list.
   *
   * @returns Whether the position was actually deleted, i.e.,
   * it was initially present.
   */
  delete(pos: Position): void;
  delete(startPos: Position, sameNodeCount: number): void;
  delete(startPos: Position, count = 1): void {
    // Validate startPos even if values.length = 0.
    const node = this.order.getNodeFor(startPos);
    if (count === 0) return;
    if (count < 0 || !Number.isInteger(count)) {
      throw new Error(`Invalid count: ${count}`);
    }
    if (node === this.order.rootNode && startPos.valueIndex + count - 1 > 1) {
      throw new Error(
        `Last value's Position is invalid (rootNode only allows valueIndex 0 or 1): startPos=${JSON.stringify(
          startPos
        )}, count=${count}`
      );
    }

    const data = this.state.get(node);
    if (data === undefined) {
      // Already deleted.
      return;
    }

    const existing = data.values.set(startPos.valueIndex, count);
    this.onUpdate(node, -existing.size);
  }

  /**
   * Deletes the value at index.
   *
   * @throws If index is not in `[0, this.length)`.
   */
  deleteAt(index: number): void {
    this.delete(this.positionAt(index));
  }

  /**
   * Call this after updating node's values.
   *
   * @param delta The change in the number of present values at node.
   */
  private onUpdate(node: Node, delta: number): void {
    // Invalidate caches.
    if (this.cachedIndexNode !== node) this.cachedIndexNode = null;

    if (delta !== 0) {
      // Update total for node and its ancestors.
      for (
        let current: Node | null = node;
        current !== null;
        current = current.parentNode
      ) {
        let data = this.state.get(current);
        if (data === undefined) {
          // TODO: omit values when empty? Incl cleaning up old ones?
          data = { total: 0, values: SparseArray.new() };
          this.state.set(current, data);
        }
        data.total += delta;
        if (data.total === 0) this.state.delete(current);
      }
    }
  }

  /**
   * Deletes every value in the list.
   *
   * The Order is unaffected (retains all Nodes).
   */
  clear() {
    this.state.clear();

    // Invalidate caches.
    this.cachedIndexNode = null;
  }

  /**
   *
   * @param prevPos
   * @param values
   * @returns { first value's new position, createdNodeDesc if created by Order }.
   * If values.length > 1, their positions start at pos using the same Node
   * with increasing valueIndex.
   * If values.length = 0, a new position is created but the List state is not
   * changed - can use this instead of calling Order.createPosition directly.
   * @throws If prevPos is order.maxPosition.
   */
  insert(
    prevPos: Position,
    ...values: T[]
  ): { pos: Position; createdNodeDesc: NodeDesc | null } {
    const ret = this.order.createPosition(prevPos);
    this.set(ret.pos, ...values);
    return ret;
  }

  /**
   *
   * @param index
   * @param values
   * @returns
   * @throws If index is this.length and our last value is at order.maxPosition.
   */
  insertAt(
    index: number,
    ...values: T[]
  ): { pos: Position; createdNodeDesc: NodeDesc | null } {
    const prevPos =
      index === 0 ? this.order.minPosition : this.positionAt(index - 1);
    return this.insert(prevPos, ...values);
  }

  // ----------
  // Accessors
  // ----------

  /**
   * Returns the value at position, or undefined if it is not currently present
   * ([[hasPosition]] returns false).
   */
  get(pos: Position): T | undefined {
    return this.getInNode(this.order.getNodeFor(pos), pos.valueIndex)[0];
  }

  /**
   * Returns the value currently at index.
   *
   * @throws If index is not in `[0, this.length)`.
   * Note that this differs from an ordinary Array,
   * which would instead return undefined.
   */
  getAt(index: number): T {
    return this.get(this.positionAt(index))!;
  }

  /**
   * Returns whether position is currently present in the list,
   * i.e., its value is present.
   */
  has(pos: Position): boolean {
    return this.getInNode(this.order.getNodeFor(pos), pos.valueIndex)[1];
  }

  /**
   * Returns info about the value at valueIndex in node:
   * [value - undefined if not present, whether it's present,
   * count of node's present values before it]
   */
  private getInNode(
    node: Node,
    valueIndex: number
  ): [value: T | undefined, isPresent: boolean, nodeValuesBefore: number] {
    const data = this.state.get(node);
    if (data === undefined) return [undefined, false, 0];
    return data.values.getInfo(valueIndex);
  }

  private cachedIndexNode: Node | null = null;
  private cachedIndex = -1;

  /**
   * Returns the current index of position.
   *
   * If position is not currently present in the list
   * ([[hasPosition]] returns false), then the result depends on searchDir:
   * - "none" (default): Returns -1.
   * - "left": Returns the next index to the left of position.
   * If there are no values to the left of position,
   * returns -1.
   * - "right": Returns the next index to the right of position.
   * If there are no values to the right of position,
   * returns [[length]].
   *
   * To find the index where a position would be if
   * present, use `searchDir = "right"`.
   */
  indexOfPosition(
    pos: Position,
    searchDir: "none" | "left" | "right" = "none"
  ): number {
    const node = this.order.getNodeFor(pos);
    const [, isPresent, nodeValuesBefore] = this.getInNode(
      node,
      pos.valueIndex
    );
    // Will be the total number of values prior to position.
    let valuesBefore = nodeValuesBefore;

    // Add totals for child nodes that come before valueIndex.
    // These are precisely the left children with
    // parentValueIndex <= valueIndex.
    for (const child of node.children()) {
      if (child.parentValueIndex > pos.valueIndex) break;
      valuesBefore += this.total(child);
    }

    // Get the number of values prior to node itself.
    let beforeNode: number;
    if (this.cachedIndexNode === node) {
      // Shortcut: We already computed beforeNode and it has not changed.
      // Use its cached value to prevent re-walking up the tree when
      // our caller loops over the same Node's Positions.
      // TODO: test
      beforeNode = this.cachedIndex;
    } else {
      // Walk up the tree and add totals for sibling values & nodes
      // that come before our ancestor.
      beforeNode = 0;
      for (
        let current = node;
        current.parentNode !== null;
        current = current.parentNode
      ) {
        // Sibling values that come before current.
        beforeNode += this.getInNode(
          current.parentNode,
          current.parentValueIndex
        )[2];
        // Sibling nodes that come before current.
        for (const child of current.parentNode.children()) {
          if (child === current) break;
          beforeNode += this.total(child);
        }
      }
      // Cache beforeNode for future calls to indexOfPosition at Node.
      // That lets us avoid re-walking up the tree when this method is called
      // in a loop over node's Positions.
      this.cachedIndexNode = node;
      this.cachedIndex = beforeNode;
    }
    valuesBefore += beforeNode;

    if (isPresent) return valuesBefore;
    else {
      switch (searchDir) {
        case "none":
          return -1;
        case "left":
          return valuesBefore - 1;
        case "right":
          return valuesBefore;
      }
    }
  }

  /**
   * Returns the position currently at index.
   *
   * Won't return minPosition or maxPosition.
   */
  positionAt(index: number): Position {
    if (index < 0 || index >= this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    let remaining = index;
    let node = this.order.rootNode;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      nodeLoop: {
        for (const next of this.slicesAndChildren(node)) {
          if (next.type === "slice") {
            const length = next.end - next.start;
            if (remaining < length) {
              // Answer is values[remaining].
              return {
                creatorID: node.creatorID,
                timestamp: node.timestamp,
                valueIndex: next.valueIndex + remaining,
              };
            } else remaining -= length;
          } else {
            if (remaining < next.total) {
              // Recurse into child.
              node = next.child;
              break nodeLoop;
            } else remaining -= next.total;
          }
        }
        // We should always end by the break statement (recursion), not by
        // the for loop's finishing.
        throw new Error("Internal error: failed to find index among children");
      }
    }
  }

  /**
   * The length of the list.
   */
  get length() {
    return this.total(this.order.rootNode);
  }

  /**
   * Returns the total number of present values at this
   * node and its descendants.
   */
  private total(node: Node): number {
    return this.state.get(node)?.total ?? 0;
  }

  // ----------
  // Iterators
  // ----------

  /** Returns an iterator for values in the list, in list order. */
  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  /**
   * Returns an iterator for values in the list, in list order.
   *
   * Args as in Array.slice.
   */
  *values(start?: number, end?: number): IterableIterator<T> {
    for (const [, value] of this.entries(start, end)) yield value;
  }

  /**
   * Returns a copy of a section of this list, as an array.
   *
   * Args as in Array.slice.
   */
  slice(start?: number, end?: number): T[] {
    return [...this.values(start, end)];
  }

  /**
   * Returns an iterator for present positions, in list order.
   *
   * Args as in Array.slice.
   */
  *positions(start?: number, end?: number): IterableIterator<Position> {
    for (const [pos] of this.entries(start, end)) yield pos;
  }

  /**
   * Returns an iterator of [pos, value, index] tuples for every
   * value in the list, in list order.
   *
   * Args as in Array.slice.
   */
  *entries(
    start?: number,
    end?: number
  ): IterableIterator<[pos: Position, value: T, index: number]> {
    const range = this.normalizeSliceRange(start, end);
    if (range === null) return [];
    [start, end] = range;

    let index = 0;
    let node: Node | null = this.order.rootNode;
    // Manage our own stack instead of recursing, to avoid stack overflow
    // in deep trees.
    const stack: IterableIterator<SliceOrChild<T>>[] = [
      // root will indeed have total != 0 since we checked length != 0.
      this.slicesAndChildren(this.order.rootNode),
    ];
    while (node !== null) {
      const iter = stack[stack.length - 1];
      const next = iter.next();
      if (next.done) {
        stack.pop();
        node = node.parentNode;
      } else {
        const valuesOrChild = next.value;
        if (valuesOrChild.type === "slice") {
          // Emit slice's values.
          const sliceLength = valuesOrChild.end - valuesOrChild.start;
          if (index + sliceLength <= start) {
            // Shortcut: We won't start by the end of the slice, so skip its loop.
            index += sliceLength;
          } else {
            for (let i = 0; i < sliceLength; i++) {
              if (index >= start) {
                yield [
                  {
                    creatorID: node.creatorID,
                    timestamp: node.timestamp,
                    valueIndex: valuesOrChild.valueIndex + i,
                  },
                  valuesOrChild.values[valuesOrChild.start + i],
                  index,
                ];
              }
              index++;
              if (index >= end) return;
            }
          }
        } else {
          // Recurse into child.
          if (index + valuesOrChild.total <= start) {
            // Shortcut: We won't start within this child, so skip its recursion.
            index += valuesOrChild.total;
          } else {
            node = valuesOrChild.child;
            stack.push(this.slicesAndChildren(node));
          }
        }
      }
    }
  }

  /**
   * Normalizes the range so that start < end and they are both in bounds
   * (possibly end=length). If the range is empty, returns null.
   */
  private normalizeSliceRange(
    start?: number,
    end?: number
  ): [start: number, end: number] | null {
    const len = this.length;
    if (start === undefined || start < -len) start = 0;
    else if (start < 0) start += len;
    else if (start >= len) return null;

    if (end === undefined || end >= len) end = len;
    else if (end < -len) end = 0;
    else if (end < 0) end += len;

    if (end <= start) return null;
    return [start, end];
  }

  /**
   * Yields non-trivial values and Node children
   * for node, in list order. This is used when
   * iterating over the list.
   *
   * Specifically, it yields:
   * - Slices of a Node's values that are present and contiguous in the list order.
   * - Node children with non-zero total.
   *
   * together with enough info to infer their starting valueIndex's.
   *
   * @throws If valuesByNode does not have an entry for node.
   */
  private *slicesAndChildren(node: Node): IterableIterator<SliceOrChild<T>> {
    const runs = this.state.get(node)!.values;
    const children = [...node.children()];
    let childIndex = 0;
    let startValueIndex = 0;
    for (const run of runs) {
      const runSize = typeof run === "number" ? run : run.length;
      // After (next startValueIndex)
      const endValueIndex = startValueIndex + runSize;
      // Next value to yield
      let valueIndex = startValueIndex;
      for (; childIndex < children.length; childIndex++) {
        const child = children[childIndex];
        if (child.parentValueIndex >= endValueIndex) {
          // child comes after run. End the loop and visit child
          // during the next run.
          break;
        }
        const total = this.total(child);
        if (total !== 0) {
          // Emit child. If needed, first emit values that come before it.
          if (valueIndex < child.parentValueIndex) {
            if (typeof run !== "number") {
              yield {
                type: "slice",
                values: run,
                start: valueIndex - startValueIndex,
                end: child.parentValueIndex - startValueIndex,
                valueIndex,
              };
            }
            valueIndex = child.parentValueIndex;
          }
          yield { type: "child", child, total };
        }
      }

      // Emit remaining values in run.
      if (typeof run !== "number" && valueIndex < endValueIndex) {
        yield {
          type: "slice",
          values: run,
          start: valueIndex - startValueIndex,
          end: runSize,
          valueIndex,
        };
      }
      startValueIndex = endValueIndex;
    }
    // Visit remaining children (left children among a possible deleted
    // final run (which runs omits) and right children).
    for (; childIndex < children.length; childIndex++) {
      const child = children[childIndex];
      const total = this.total(child);
      if (this.total(child) !== 0) {
        yield { type: "child", child, total };
      }
    }
  }

  // ----------
  // Save & Load
  // ----------

  saveOneNode(node: Node): {
    [valueIndex: number]: T;
  } {
    const data = this.state.get(node);
    if (data === undefined) return {};
    return data.values.save();
  }

  /**
   * Overwrites all of node's existing values - so non-present keys become
   * deleted, even if they come after the last present key.
   *
   * Note that values might not be contiguous in the list.
   */
  loadOneNode(
    node: Node,
    valuesObj: {
      [valueIndex: number]: T;
    }
  ): void {
    let data = this.state.get(node);
    if (data === undefined) {
      data = { total: 0, values: SparseArray.new() };
      this.state.set(node, data);
    }

    const existingCount = data.values.size;
    data.values.load(valuesObj);
    this.onUpdate(node, data.values.size - existingCount);
  }

  /**
   * Returns saved state describing the current state of this LocalList,
   * including its values.
   *
   * The saved state may later be passed to [[load]]
   * on a new instance of LocalList, to reconstruct the
   * same list state.
   *
   * Only saves values, not Order. "Natural" format; order
   * guarantees.
   */
  save(): ListSavedState<T> {
    const savedStatePre: ListSavedState<T> = {};
    for (const [node, data] of this.state) {
      if (data.values.length === 0) continue;

      let byCreator = savedStatePre[node.creatorID];
      if (byCreator === undefined) {
        byCreator = {};
        savedStatePre[node.creatorID] = byCreator;
      }

      byCreator[node.timestamp] = data.values.save();
    }

    // Make a (shallow) copy of savedStatePre that touches all
    // creatorIDs in lexicographic order, to ensure consistent JSON
    // serialization order for identical states. (JSON field order is: non-negative
    // integers in numeric order, then string keys in creation order.)
    const sortedCreatorIDs = Object.keys(savedStatePre);
    sortedCreatorIDs.sort();
    const savedState: ListSavedState<T> = {};
    for (const creatorID of sortedCreatorIDs) {
      savedState[creatorID] = savedStatePre[creatorID];
    }

    return savedState;
  }

  /**
   * Loads saved state. The saved state must be from
   * a call to [[save]] on a LocalList whose `source`
   * constructor argument was a replica of this's
   * `source`, so that we can understand the
   * saved state's Positions.
   *
   * Overwrites whole state - not state-based merge.
   *
   * @param savedState Saved state from a List's
   * [[save]] call.
   */
  load(savedState: ListSavedState<T>): void {
    this.clear();

    for (const [creatorID, byCreator] of Object.entries(savedState)) {
      for (const [timestampStr, valuesObj] of Object.entries(byCreator)) {
        const timestamp = Number.parseInt(timestampStr);
        if (isNaN(timestamp)) {
          throw new Error(
            `Non-integer timestamp in ListSavedState: ${timestampStr}`
          );
        }
        const node = this.order.getNode(creatorID, timestamp);
        if (node === undefined) {
          throw new Error(
            `List.load savedState references missing Node: ${JSON.stringify({
              creatorID,
              timestamp,
            })}. You must call Order.addNodeDescs before referencing a Node.`
          );
        }
        this.loadOneNode(node, valuesObj);
      }
    }
  }
}
