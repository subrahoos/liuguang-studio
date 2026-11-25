type Patch = Record<string, unknown>;
type Atom = { key: string; patch: Patch; version: number };

function splitPatch(patch: Patch): Array<Omit<Atom, "version">> {
  const atoms: Array<Omit<Atom, "version">> = [];
  for (const [field, value] of Object.entries(patch)) {
    if (field === "videoSourceUpdate") {
      const update = value as { id: string; patch: Patch };
      for (const [key, next] of Object.entries(update.patch)) {
        atoms.push({ key: `source:${update.id}:${key}`, patch: { videoSourceUpdate: { id: update.id, patch: { [key]: next } } } });
      }
    } else {
      atoms.push({ key: field === "removeAssetId" ? `remove:${String(value)}` : field, patch: { [field]: value } });
    }
  }
  return atoms;
}

function combine(atoms: Atom[]): Patch {
  const patch: Patch = {};
  for (const atom of atoms) {
    if (atom.patch.videoSourceUpdate) {
      const update = atom.patch.videoSourceUpdate as { id: string; patch: Patch };
      const previous = patch.videoSourceUpdate as { id: string; patch: Patch } | undefined;
      patch.videoSourceUpdate = { id: update.id, patch: { ...previous?.patch, ...update.patch } };
    } else Object.assign(patch, atom.patch);
  }
  return patch;
}

// One latest intent per field: an old failure cannot replay a newer saved value.
export class ProductionSaveLedger {
  private sequence = 0;
  private latest = new Map<string, number>();
  private failed = new Map<string, Atom>();

  begin(patch: Patch): Atom[] {
    return splitPatch(patch).map((atom) => {
      const version = ++this.sequence;
      this.latest.set(atom.key, version);
      this.failed.delete(atom.key);
      return { ...atom, version };
    });
  }
  currentPatch(attempt: Atom[]): Patch {
    return combine(attempt.filter((atom) => this.latest.get(atom.key) === atom.version));
  }
  succeed(attempt: Atom[]) {
    for (const atom of attempt) if (this.latest.get(atom.key) === atom.version) this.failed.delete(atom.key);
  }
  fail(attempt: Atom[]) {
    for (const atom of attempt) if (this.latest.get(atom.key) === atom.version) this.failed.set(atom.key, atom);
  }
  retryPatches(): Patch[] { return [...this.failed.values()].map((atom) => atom.patch); }
  get hasFailures() { return this.failed.size > 0; }
  clear() { this.latest.clear(); this.failed.clear(); }
}
