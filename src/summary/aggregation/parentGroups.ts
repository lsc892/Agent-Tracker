// 최상위 부모를 한 번 해소하고 같은 계보를 root별로 직접 그룹화한다.
export interface ParentItem<T> {
  id: string;
  parentId: string | null;
  value: T;
}

export interface ParentGroup<T> {
  /** 원본 계보의 최상위 부모 식별자. */
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
  const groups = new Map<string, ParentGroup<T>>();
  const unresolved = new Set<string>();
  const resolved = new Map<string, ParentGroup<T>>();
  for (const [id, members] of values) {
    const root = roots.get(id)!;
    if (root === null) {
      unresolved.add(id);
      groups.set(id, { rootId: id, members: new Map([[id, members]]) });
    } else {
      let group = resolved.get(root);
      if (!group) resolved.set(root, group = { rootId: root, members: new Map() });
      group.members.set(id, members);
      groups.set(id, group);
    }
  }
  return { groups, unresolved };
}

/** 각 연결의 결과를 기억하며 깊은 계보도 재귀 스택 없이 해소한다. */
function resolveRoots(parents: Map<string, string | null>, conflicts: Set<string>): Map<string, string | null> {
  const roots = new Map<string, string | null>();
  for (const start of parents.keys()) {
    if (roots.has(start)) continue;
    const path: string[] = [];
    let current = start, root: string | null = null;
    while (true) {
      if (roots.has(current)) { root = roots.get(current)!; break; }
      if (!parents.has(current) || conflicts.has(current)) break;
      // 해소 중인 노드는 null로 표시해 같은 경로로 돌아오는 순환도 감지한다.
      roots.set(current, null);
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
