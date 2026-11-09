// 직접 자식은 부모 그룹에 모으고 다단계 계보만 Union-Find와 작은 Map 병합으로 연결한다.
export interface ParentItem<T> {
  id: string;
  parentId: string | null;
  value: T;
}

export interface ParentGroup<T> {
  /** Union-Find 대표와 별개인 원본 계보의 최상위 부모 식별자. */
  rootId: string;
  members: Map<string, T[]>;
}

export interface ParentGroups<T> {
  /** 같은 계보의 thread는 같은 그룹 객체를 가리킨다. */
  groups: Map<string, ParentGroup<T>>;
  /** 부모 누락·충돌·순환이 있거나 그런 조상에 의존하는 thread. */
  unresolved: Set<string>;
}

/** 식별자만으로 계보를 연결하며 해소하지 못한 원본은 각각 독립 그룹으로 남긴다. */
export function groupParents<T>(items: readonly ParentItem<T>[]): ParentGroups<T> {
  const parents = new Map<string, string | null>();
  const values = new Map<string, T[]>();
  const conflicts = new Set<string>();
  for (const item of items) {
    if (parents.has(item.id) && parents.get(item.id) !== item.parentId) conflicts.add(item.id);
    else parents.set(item.id, item.parentId);
    const previous = values.get(item.id);
    if (previous) previous.push(item.value);
    else values.set(item.id, [item.value]);
  }

  const roots = resolveRoots(parents, conflicts);
  const nestedRoots = new Set<string>();
  for (const [id, parent] of parents) {
    const root = roots.get(id);
    if (root !== null && root !== undefined && parent !== null && parents.get(parent) != null) nestedRoots.add(root);
  }

  const groups = new Map<string, ParentGroup<T>>();
  const unresolved = new Set<string>();
  const direct = new Map<string, ParentGroup<T>>();
  const representatives = new Map<string, string>();
  const components = new Map<string, ParentGroup<T>>();
  for (const [id, members] of values) {
    const root = roots.get(id);
    if (root === null || root === undefined) {
      unresolved.add(id);
      groups.set(id, { rootId: id, members: new Map([[id, members]]) });
    } else if (nestedRoots.has(root)) {
      representatives.set(id, id);
      components.set(id, { rootId: root, members: new Map([[id, members]]) });
    } else {
      let group = direct.get(root);
      if (!group) direct.set(root, group = { rootId: root, members: new Map() });
      group.members.set(id, members);
      groups.set(id, group);
    }
  }

  const find = (id: string): string => {
    let representative = id;
    while (representatives.get(representative) !== representative) representative = representatives.get(representative)!;
    while (id !== representative) {
      const parent = representatives.get(id)!;
      representatives.set(id, representative);
      id = parent;
    }
    return representative;
  };
  for (const [id, parent] of parents) {
    if (parent === null || !representatives.has(id)) continue;
    let left = find(id), right = find(parent);
    if (left === right) continue;
    if (components.get(left)!.members.size < components.get(right)!.members.size) [left, right] = [right, left];
    const target = components.get(left)!, source = components.get(right)!;
    for (const [member, bucket] of source.members) target.members.set(member, bucket);
    representatives.set(right, left);
    components.delete(right);
  }
  for (const id of representatives.keys()) groups.set(id, components.get(find(id))!);
  return { groups, unresolved };
}

/** 각 연결의 결과를 기억하며 깊은 계보도 재귀 스택 없이 해소한다. */
function resolveRoots(parents: Map<string, string | null>, conflicts: Set<string>): Map<string, string | null> {
  const roots = new Map<string, string | null>();
  for (const start of parents.keys()) {
    if (roots.has(start)) continue;
    const path: string[] = [], visiting = new Set<string>();
    let current = start, root: string | null = null;
    while (true) {
      if (roots.has(current)) { root = roots.get(current)!; break; }
      if (!parents.has(current) || conflicts.has(current) || visiting.has(current)) break;
      visiting.add(current);
      path.push(current);
      const parent = parents.get(current)!;
      if (parent === null) { root = current; break; }
      current = parent;
    }
    for (const id of path) roots.set(id, root);
    // 충돌한 시작 노드는 방문 경로에 들어가기 전에 중단될 수 있다.
    if (!roots.has(start)) roots.set(start, null);
  }
  return roots;
}
