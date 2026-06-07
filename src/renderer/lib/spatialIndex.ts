import RBush from 'rbush';

/**
 * Spatial index item stored in the R-tree.
 */
export interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
}

/**
 * Rect for querying the spatial index.
 */
export interface QueryRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * SpatialIndex — wraps rbush R-tree for efficient viewport culling
 * and collision detection on the infinite canvas.
 */
export class SpatialIndex {
  private tree: RBush<SpatialItem>;
  private items: Map<string, SpatialItem>;

  constructor() {
    this.tree = new RBush<SpatialItem>();
    this.items = new Map();
  }

  /**
   * Inserts an item into the index.
   */
  insert(id: string, x: number, y: number, width: number, height: number): void {
    const item: SpatialItem = {
      minX: x,
      minY: y,
      maxX: x + width,
      maxY: y + height,
      id,
    };

    // Remove existing entry if updating
    if (this.items.has(id)) {
      this.remove(id);
    }

    this.tree.insert(item);
    this.items.set(id, item);
  }

  /**
   * Removes an item by ID.
   */
  remove(id: string): void {
    const item = this.items.get(id);
    if (item) {
      this.tree.remove(item, (a, b) => a.id === b.id);
      this.items.delete(id);
    }
  }

  /**
   * Updates an item's position/size.
   */
  update(id: string, x: number, y: number, width: number, height: number): void {
    this.insert(id, x, y, width, height);
  }

  /**
   * Queries for all items intersecting the given viewport rect.
   * Returns an array of item IDs.
   */
  queryViewport(rect: QueryRect): string[] {
    const results = this.tree.search({
      minX: rect.left,
      minY: rect.top,
      maxX: rect.right,
      maxY: rect.bottom,
    });
    return results.map((r) => r.id);
  }

  /**
   * Returns all items currently in the index.
   */
  all(): SpatialItem[] {
    return this.tree.all();
  }

  /**
   * Returns the full items whose AABB intersects the given region rect.
   * Unlike {@link queryViewport} (which returns ids), this returns the
   * `SpatialItem`s so callers that need each item's extents (e.g. smart
   * connection routing building a Hanan grid from obstacle edges) get them
   * directly. H4 (perf): replaces an `all().filter(...)` linear scan over
   * every tile with an R-tree range query bounded to the region.
   */
  searchRegion(minX: number, minY: number, maxX: number, maxY: number): SpatialItem[] {
    return this.tree.search({ minX, minY, maxX, maxY });
  }

  /**
   * Clears all items from the index.
   */
  clear(): void {
    this.tree.clear();
    this.items.clear();
  }
}
