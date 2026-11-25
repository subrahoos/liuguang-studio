export function createBoundedOwnerScheduler<T extends { id: string }>(
  limit: number,
  select: (ownerId: string, activeJobIds: ReadonlySet<string>) => Promise<T | null>,
  execute: (ownerId: string, job: T) => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
) {
  type OwnerState = { activeJobIds: Set<string>; filling: boolean; pending: boolean };
  const owners = new Map<string, OwnerState>();

  async function fill(ownerId: string, state: OwnerState) {
    if (state.filling) return;
    state.filling = true;
    try {
      do {
        state.pending = false;
        while (state.activeJobIds.size < limit) {
          const selected = await select(ownerId, state.activeJobIds);
          if (!selected) break;
          if (state.activeJobIds.has(selected.id)) throw new Error(`重复调度商品生产任务：${selected.id}`);
          state.activeJobIds.add(selected.id);
          void Promise.resolve().then(() => execute(ownerId, selected)).then(
            () => {
              state.activeJobIds.delete(selected.id);
              wake(ownerId);
            },
            (error) => {
              state.activeJobIds.delete(selected.id);
              onError(error);
              if (state.activeJobIds.size > 0) wake(ownerId);
              else if (!state.filling && !state.pending) owners.delete(ownerId);
            },
          );
        }
      } while (state.pending && state.activeJobIds.size < limit);
    } catch (error) {
      onError(error);
    } finally {
      state.filling = false;
      if (state.pending) void fill(ownerId, state);
      else if (state.activeJobIds.size === 0) owners.delete(ownerId);
    }
  }

  function wake(ownerId: string) {
    let state = owners.get(ownerId);
    if (!state) {
      state = { activeJobIds: new Set(), filling: false, pending: false };
      owners.set(ownerId, state);
    }
    state.pending = true;
    if (!state.filling) void fill(ownerId, state);
  }

  return { wake };
}
