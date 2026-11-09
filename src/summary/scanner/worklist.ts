// 관계별 멤버와 처리 후보를 색인하고 기존 순서를 유지하며 중복 방문을 막는다.
export function addMember<T>(index: Map<string, Set<T>>, key: string, value: T): void {
  let members = index.get(key);
  if (!members) index.set(key, members = new Set());
  members.add(value);
}

export function removeMember<T>(index: Map<string, Set<T>>, key: string, value: T): void {
  const members = index.get(key);
  members?.delete(value);
  if (members?.size === 0) index.delete(key);
}

/** 파일 ID 우선순위를 유지하는 중복 없는 최소 힙 작업 큐. */
export class SourceQueue<T extends { id: number }> {
  private readonly heap: T[] = [];
  private readonly queued = new Set<T>();

  add(value: T): void {
    if (this.queued.has(value)) return;
    this.queued.add(value);
    let index = this.heap.length;
    this.heap.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.heap[parent].id <= value.id) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = value;
  }

  take(): T | undefined {
    const first = this.heap[0];
    if (!first) return undefined;
    this.queued.delete(first);
    const last = this.heap.pop()!;
    if (this.heap.length) {
      let index = 0;
      while (index * 2 + 1 < this.heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.heap.length && this.heap[child + 1].id < this.heap[child].id) child++;
        if (last.id <= this.heap[child].id) break;
        this.heap[index] = this.heap[child];
        index = child;
      }
      this.heap[index] = last;
    }
    return first;
  }
}

/** 여러 그룹의 멤버를 원래 입력 순서대로 합쳐 전체 배열의 반복 filter를 대신한다. */
export class OrderedGroups<T> {
  private readonly groups = new Map<string, Set<T>>();
  private readonly order = new Map<T, number>();

  constructor(values: Iterable<T>, keys: (value: T) => Iterable<string>) {
    let index = 0;
    for (const value of values) {
      this.order.set(value, index++);
      for (const key of keys(value)) addMember(this.groups, key, value);
    }
  }

  members(keys: Iterable<string>): T[] {
    const members = new Set<T>();
    for (const key of keys)
      for (const value of this.groups.get(key) ?? []) members.add(value);
    return [...members].sort((a, b) => this.order.get(a)! - this.order.get(b)!);
  }
}
