import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';

// Logical Clock / Epoch Sec derivation for commits
let epochTick = 0;
export function nextEpochSec(): number {
  epochTick++;
  return 1735689600 + epochTick * 60; // 2025-01-01 00:00:00 UTC + tick increments
}

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export function sha1Object(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  const store = Buffer.concat([header, data]);
  return crypto.createHash('sha1').update(store).digest('hex');
}

export interface TreeEntry {
  mode: string; // '100644' or '40000'
  name: string;
  oid: string; // hex sha1
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(32, offset); // space ' '
    if (spaceIdx === -1) break;
    const mode = data.toString('utf8', offset, spaceIdx);
    const nullIdx = data.indexOf(0, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = data.toString('utf8', spaceIdx + 1, nullIdx);
    const shaBytes = data.subarray(nullIdx + 1, nullIdx + 21);
    if (shaBytes.length < 20) break;
    const oid = shaBytes.toString('hex');
    entries.push({ mode, name, oid });
    offset = nullIdx + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aName = a.mode === '40000' ? `${a.name}/` : a.name;
    const bName = b.mode === '40000' ? `${b.name}/` : b.name;
    if (aName < bName) return -1;
    if (aName > bName) return 1;
    return 0;
  });

  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    const header = `${entry.mode} ${entry.name}\0`;
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitObject {
  const text = data.toString('utf8');
  const parts = text.split('\n\n');
  const headerLines = parts[0].split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of headerLines) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim());
    } else if (line.startsWith('author ')) {
      author = line.slice(7).trim();
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10).trim();
    }
  }
  const message = parts.slice(1).join('\n\n');
  return { tree, parents, author, committer, message };
}

export function serializeCommit(c: CommitObject): Buffer {
  let header = `tree ${c.tree}\n`;
  for (const p of c.parents) {
    header += `parent ${p}\n`;
  }
  header += `author ${c.author}\n`;
  header += `committer ${c.committer}\n\n`;
  header += c.message;
  return Buffer.from(header, 'utf8');
}

// Delta application helper
export function applyDelta(baseData: Buffer, deltaData: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): { value: number; length: number } => {
    let shift = 0;
    let value = 0;
    let len = 0;
    while (offset + len < deltaData.length) {
      const c = deltaData[offset + len];
      len++;
      value |= (c & 0x7f) << shift;
      if (!(c & 0x80)) break;
      shift += 7;
    }
    offset += len;
    return { value, length: len };
  };

  const sourceSize = readVarint().value;
  if (baseData.length !== sourceSize) {
    // optional check
  }
  const targetSize = readVarint().value;
  const target = Buffer.alloc(targetSize);
  let targetOffset = 0;

  while (offset < deltaData.length) {
    const cmd = deltaData[offset++];
    if (cmd & 0x80) {
      // Copy from base
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= deltaData[offset++];
      if (cmd & 0x02) cpOff |= deltaData[offset++] << 8;
      if (cmd & 0x04) cpOff |= deltaData[offset++] << 16;
      if (cmd & 0x08) cpOff |= deltaData[offset++] << 24;

      if (cmd & 0x10) cpSize |= deltaData[offset++];
      if (cmd & 0x20) cpSize |= deltaData[offset++] << 8;
      if (cmd & 0x40) cpSize |= deltaData[offset++] << 16;
      if (cpSize === 0) cpSize = 0x10000;

      baseData.copy(target, targetOffset, cpOff, cpOff + cpSize);
      targetOffset += cpSize;
    } else if (cmd > 0) {
      // Insert literal
      deltaData.copy(target, targetOffset, offset, offset + cmd);
      targetOffset += cmd;
      offset += cmd;
    } else {
      throw new Error('Unexpected delta opcode 0');
    }
  }
  return target;
}

export function packEncode(objects: Map<string, { type: GitObjectType; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  chunks.push(header);

  for (const [oid, obj] of objects.entries()) {
    let typeNum = 1;
    if (obj.type === 'commit') typeNum = 1;
    else if (obj.type === 'tree') typeNum = 2;
    else if (obj.type === 'blob') typeNum = 3;
    else if (obj.type === 'tag') typeNum = 4;

    let size = obj.data.length;
    let byte = ((typeNum & 7) << 4) | (size & 15);
    size >>= 4;
    const headerBytes: number[] = [];
    headerBytes.push(byte);
    while (size > 0) {
      headerBytes[headerBytes.length - 1] |= 0x80;
      byte = size & 127;
      size >>= 7;
      headerBytes.push(byte);
    }
    chunks.push(Buffer.from(headerBytes));
    const compressed = zlib.deflateSync(obj.data);
    chunks.push(compressed);
  }

  const tempPack = Buffer.concat(chunks);
  const hash = crypto.createHash('sha1').update(tempPack).digest();
  return Buffer.concat([tempPack, hash]);
}

export function packDecode(packBuf: Buffer, externalObjects?: Map<string, { type: GitObjectType; data: Buffer }>): Map<string, { type: GitObjectType; data: Buffer }> {
  const result = new Map<string, { type: GitObjectType; data: Buffer }>();
  if (packBuf.length < 20) return result;
  if (packBuf.toString('utf8', 0, 4) !== 'PACK') return result;

  const numObjects = packBuf.readUInt32BE(8);
  let offset = 12;

  // We need to keep track of objects in this pack for OFS_DELTA
  const decodedInPack: { type: GitObjectType; data: Buffer; offset: number }[] = [];

  for (let i = 0; i < numObjects; i++) {
    const objStartOffset = offset;
    let c = packBuf[offset++];
    let typeNum = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = packBuf[offset++];
      size |= (c & 127) << shift;
      shift += 7;
    }

    let refOid: string | undefined;
    let baseOffset: number | undefined;

    if (typeNum === 6) {
      // OFS_DELTA
      let c2 = packBuf[offset++];
      let val = c2 & 127;
      while (c2 & 0x80) {
        c2 = packBuf[offset++];
        val = ((val + 1) << 7) | (c2 & 127);
      }
      baseOffset = objStartOffset - val;
    } else if (typeNum === 7) {
      // REF_DELTA
      refOid = packBuf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    // Find zlib stream length using binary search or trial inflate
    let zlibStreamLen = 1;
    let inflatedData: Buffer | null = null;

    // Binary search max possible remaining length
    let low = 1;
    let high = packBuf.length - offset;
    let bestLen = high;

    // Try inflating with increasing lengths or binary search
    // Since zlib.inflateSync ignores trailing extra bytes if valid zlib stream is found,
    // we can find the exact length where zlib succeeds and produces expected size (if we know size).
    // Actually, zlib.inflateSync on a subarray of length L might succeed. We want the smallest L.
    // Let's do a binary search for L in [1, packBuf.length - offset]:
    low = 1;
    high = packBuf.length - offset;
    while (low <= high) {
      const mid = (low + high) >> 1;
      try {
        const candidate = packBuf.subarray(offset, offset + mid);
        const inf = zlib.inflateSync(candidate);
        if (typeNum !== 6 && typeNum !== 7 && inf.length === size) {
          inflatedData = inf;
          bestLen = mid;
          high = mid - 1; // try smaller
        } else if ((typeNum === 6 || typeNum === 7) && inf.length > 0) {
          // For delta, size is target size in delta or we just test inflation success
          inflatedData = inf;
          bestLen = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } catch {
        low = mid + 1;
      }
    }

    // If binary search didn't find exact size matching, fallback to scanning or full remaining
    if (!inflatedData) {
      try {
        const inf = zlib.inflateSync(packBuf.subarray(offset));
        inflatedData = inf;
        bestLen = packBuf.length - offset; // consume rest or find where zlib ends? zlib consumes what it needs.
      } catch (e) {
        throw new Error(`Failed to inflate object at offset ${offset}: ${e}`);
      }
    }

    // The binary search above already found the smallest slice that inflates
    // (zlib.inflateSync ignores trailing bytes and throws on a truncated
    // stream), so bestLen IS the exact stream length. No linear scan needed.
    const consumed = bestLen;
    offset += consumed;

    let finalType: GitObjectType = 'blob';
    let finalData: Buffer = Buffer.alloc(0);

    if (typeNum === 1) { finalType = 'commit'; finalData = inflatedData!; }
    else if (typeNum === 2) { finalType = 'tree'; finalData = inflatedData!; }
    else if (typeNum === 3) { finalType = 'blob'; finalData = inflatedData!; }
    else if (typeNum === 4) { finalType = 'tag'; finalData = inflatedData!; }
    else if (typeNum === 6) {
      // OFS_DELTA
      const baseObj = decodedInPack.find(o => o.offset === baseOffset);
      if (!baseObj) throw new Error(`Base object at offset ${baseOffset} not found for OFS_DELTA`);
      finalData = applyDelta(baseObj.data, inflatedData!);
      finalType = baseObj.type;
    } else if (typeNum === 7) {
      // REF_DELTA
      let base = result.get(refOid!) || externalObjects?.get(refOid!);
      if (!base) {
        // search in decodedInPack by computing oid
        for (const d of decodedInPack) {
          const oid = sha1Object(d.type, d.data);
          if (oid === refOid) {
            base = d;
            break;
          }
        }
      }
      if (!base) throw new Error(`Base object ${refOid} not found for REF_DELTA`);
      finalData = applyDelta(base.data, inflatedData!);
      finalType = base.type;
    }

    const oid = sha1Object(finalType, finalData);
    result.set(oid, { type: finalType, data: finalData });
    decodedInPack.push({ type: finalType, data: finalData, offset: objStartOffset });
  }

  return result;
}

export class GitRepoStore {
  objects = new Map<string, { type: GitObjectType; data: Buffer }>();
  refs = new Map<string, string>(); // refname -> oid
  branchFiles = new Map<string, Map<string, Buffer>>(); // branch -> (path -> content Buffer)
  commitFiles = new Map<string, Map<string, Buffer>>(); // commitOid -> (path -> content Buffer)
  packCache = new Map<string, Buffer>();

  writeObject(type: GitObjectType, data: Buffer): string {
    const oid = sha1Object(type, data);
    this.objects.set(oid, { type, data });
    return oid;
  }

  writeBlob(content: Buffer): string {
    return this.writeObject('blob', content);
  }

  addDecoded(map: Map<string, { type: GitObjectType; data: Buffer }>) {
    for (const [oid, obj] of map.entries()) {
      this.objects.set(oid, obj);
    }
  }

  writeTreeFromMap(fileMap: Map<string, Buffer>): string {
    const rootEntries: Map<string, { mode: string; subMap?: Map<string, Buffer>; blobOid?: string }> = new Map();

    for (const [filePath, content] of fileMap.entries()) {
      const parts = filePath.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      
      let currMap = rootEntries;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        let entry = currMap.get(part);
        if (!entry) {
          entry = { mode: '40000', subMap: new Map() };
          currMap.set(part, entry);
        }
        if (!entry.subMap) {
          entry.subMap = new Map();
        }
        currMap = entry.subMap;
      }

      const fileName = parts[parts.length - 1];
      const blobOid = this.writeBlob(content);
      currMap.set(fileName, { mode: '100644', blobOid });
    }

    const buildSubTree = (map: Map<string, { mode: string; subMap?: Map<string, Buffer>; blobOid?: string }>): string => {
      const treeEntries: TreeEntry[] = [];
      for (const [name, entry] of map.entries()) {
        if (entry.mode === '40000' && entry.subMap) {
          const subOid = buildSubTree(entry.subMap);
          treeEntries.push({ mode: '40000', name, oid: subOid });
        } else if (entry.mode === '100644' && entry.blobOid) {
          treeEntries.push({ mode: '100644', name, oid: entry.blobOid });
        }
      }
      const data = serializeTree(treeEntries);
      return this.writeObject('tree', data);
    };

    return buildSubTree(rootEntries);
  }

  writeCommit(treeOid: string, parents: string[], message: string, epochSec?: number): string {
    const sec = epochSec ?? nextEpochSec();
    const sig = `adaiversen <adaiversen@example.invalid> ${sec} +0000`;
    const commitObj: CommitObject = {
      tree: treeOid,
      parents,
      author: sig,
      committer: sig,
      message: message.endsWith('\n') ? message : `${message}\n`
    };
    const data = serializeCommit(commitObj);
    return this.writeObject('commit', data);
  }

  commitFileMap(commitOid: string): Map<string, Buffer> {
    const cached = this.commitFiles.get(commitOid);
    if (cached) return new Map(cached);
    const out = new Map<string, Buffer>();
    const commitObj = this.objects.get(commitOid);
    if (!commitObj || commitObj.type !== 'commit') return out;
    const parsed = parseCommit(commitObj.data);
    const walk = (treeOid: string, prefix: string): void => {
      const treeObj = this.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        const fullPath = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.mode === '40000') {
          walk(entry.oid, fullPath);
        } else {
          const blob = this.objects.get(entry.oid);
          if (blob && blob.type === 'blob') out.set(fullPath, Buffer.from(blob.data));
        }
      }
    };
    walk(parsed.tree, '');
    this.commitFiles.set(commitOid, new Map(out));
    return out;
  }

  isAncestor(commitOid: string, ancestorOid: string): boolean {
    if (commitOid === ancestorOid) return true;
    const obj = this.objects.get(commitOid);
    if (obj && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.parents.includes(ancestorOid)) return true;
    }
    const visited = new Set<string>([commitOid]);
    const queue = [commitOid];
    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      if (curr === ancestorOid) return true;
      const cObj = this.objects.get(curr);
      if (cObj && cObj.type === 'commit') {
        const commit = parseCommit(cObj.data);
        for (const p of commit.parents) {
          if (!visited.has(p)) {
            visited.add(p);
            queue.push(p);
          }
        }
      }
    }
    return false;
  }

  mergeBase(oid1: string, oid2: string): string | null {
    const ancestors1 = new Set<string>();
    const queue = [oid1];
    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      if (ancestors1.has(curr)) continue;
      ancestors1.add(curr);
      const obj = this.objects.get(curr);
      if (obj && obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        for (const p of commit.parents) {
          queue.push(p);
        }
      }
    }

    const visited2 = new Set<string>();
    const queue2 = [oid2];
    let head2 = 0;
    while (head2 < queue2.length) {
      const curr = queue2[head2++];
      if (ancestors1.has(curr)) return curr;
      if (visited2.has(curr)) continue;
      visited2.add(curr);
      const obj = this.objects.get(curr);
      if (obj && obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        for (const p of commit.parents) {
          queue2.push(p);
        }
      }
    }
    return null;
  }

  packEncode(): Buffer {
    return packEncode(this.objects);
  }
}
