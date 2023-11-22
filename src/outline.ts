import { ItemList } from "./item_list";
import { Node, NodeDesc } from "./node";
import { Order } from "./order";
import { Position } from "./position";
import { NumberItemManager, SparseArray } from "./sparse_array";

/**
 * TODO: Explain format (double-map to alternating present, deleted
 * counts, starting with present (maybe 0)). JSON ordering guarantees.
 */
export type OutlineSavedState = {
  [creatorID: string]: {
    [timestamp: number]: number[];
  };
};

function saveArray(arr: SparseArray<number>): number[] {
  // Defensive copy
  return arr.slice();
}

function loadArray(savedArr: number[]): number[] {
  // Defensive copy
  return savedArr.slice();
}

/**
 * Like List, but doesn't track values. Instead, tracks which are present and
 * converts between indexes and Positions.
 *
 * Can use this to save memory when you have values in separate list-like
 * data structure, e.g., a rich-text editor's internal representation.
 */
export class Outline {
  readonly order: Order;
  private readonly itemList: ItemList<number, true>;

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
  constructor(order?: Order) {
    this.order = order ?? new Order();
    this.itemList = new ItemList(this.order, new NumberItemManager());
  }

  // TODO: way to convert to/from regular arrays { lexPos: value }[] (Gurgen suggestion).

  // ----------
  // Mutators
  // ----------

  /**
   * Sets the value at `pos`.
   *
   * @throws TODO pos invalid
   */
  set(pos: Position): void;
  /**
   * TODO
   *
   * If multiple values are given, they are set starting at startPos
   * in the same Node. Note these might not be contiguous anymore,
   * unless they are new (no causally-future Positions set yet).
   * @param startPos
   * @param sameNodeValues
   */
  set(startPos: Position, count: number): void;
  set(startPos: Position, count = 1): void {
    // TODO: return existing.save()? Likewise in delete, setAt?, deleteAt?
    this.itemList.set(startPos, count);
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
    this.itemList.delete(startPos, count);
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
   * Deletes every value in the list.
   *
   * The Order is unaffected (retains all Nodes).
   */
  clear() {
    this.itemList.clear();
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
    count: number
  ): { startPos: Position; createdNodeDesc: NodeDesc | null } {
    return this.itemList.insert(prevPos, count);
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
    count: number
  ): { startPos: Position; createdNodeDesc: NodeDesc | null } {
    return this.itemList.insertAt(index, count);
  }

  // ----------
  // Accessors
  // ----------

  /**
   * Returns whether position is currently present in the list,
   * i.e., its value is present.
   */
  has(pos: Position): boolean {
    return this.itemList.has(pos);
  }

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
    return this.itemList.indexOfPosition(pos, searchDir);
  }

  /**
   * Returns the position currently at index.
   *
   * Won't return minPosition or maxPosition. TODO: actually, will if they're
   * part of the list - check that code is compatible.
   */
  positionAt(index: number): Position {
    return this.itemList.positionAt(index);
  }

  /**
   * The length of the list.
   */
  get length() {
    return this.itemList.length;
  }

  // ----------
  // Iterators
  // ----------

  /**
   * Returns an iterator of [pos, index] tuples for every
   * value in the list, in list order.
   */
  [Symbol.iterator](): IterableIterator<[pos: Position, index: number]> {
    return this.entries();
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
   * Returns an iterator of [pos, index] tuples for every
   * value in the list, in list order.
   *
   * Args as in Array.slice.
   */
  *entries(
    start?: number,
    end?: number
  ): IterableIterator<[pos: Position, index: number]> {
    for (const [pos, , index] of this.itemList.entries(start, end)) {
      yield [pos, index];
    }
  }

  // ----------
  // Save & Load
  // ----------

  saveOneNode(node: Node): number[] {
    const arr = this.itemList.saveOneNode(node);
    if (arr === undefined) return [];
    return saveArray(arr);
  }

  /**
   * Overwrites all of node's existing values - so non-present keys become
   * deleted, even if they come after the last present key.
   *
   * Note that values might not be contiguous in the list.
   */
  loadOneNode(node: Node, nodeSavedState: number[]): void {
    this.itemList.loadOneNode(node, loadArray(nodeSavedState));
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
  save(): OutlineSavedState {
    return this.itemList.save(saveArray);
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
  load(savedState: OutlineSavedState): void {
    this.itemList.load(savedState, loadArray);
  }
}
