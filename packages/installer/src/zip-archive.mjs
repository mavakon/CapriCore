// SPDX-License-Identifier: GPL-3.0-only
/**
 * Portable counterpart of Expand-CapriArchive (packages/installer/windows/common.ps1)
 * for hosts without PowerShell. It reads the central directory itself and
 * refuses the same unsafe entries: parent or current-directory segments,
 * absolute paths, drive or control characters, symbolic links, duplicates
 * (compared without case, as on the default macOS volume) and archives that
 * expand beyond their budget. Every entry is inflated with a size bound and
 * checked against its CRC-32 before it is written into an empty folder.
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  fstatSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { noLinks } from './policy.mjs';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const MAX_ENTRIES = 10000;
const MAX_NAME_BYTES = 1024;

let crcTable;
export function crc32(buffer) {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++)
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readAt(descriptor, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (count === 0) throw new Error('The archive is truncated.');
    offset += count;
  }
  return buffer;
}

/** Validated entry list. Throws before anything is written when one entry is unsafe. */
export function zipEntries(archive, { maximumBytes = 20 * 1024 ** 3 } = {}) {
  const descriptor = openSync(archive, 'r');
  try {
    return readDirectory(descriptor, maximumBytes);
  } finally {
    closeSync(descriptor);
  }
}

function readDirectory(descriptor, maximumBytes) {
  const size = fstatSync(descriptor).size;
  if (size < 22) throw new Error('The archive is not a ZIP file.');
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = readAt(descriptor, size - tailLength, tailLength);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index--)
    if (
      tail.readUInt32LE(index) === END_OF_DIRECTORY &&
      index + 22 + tail.readUInt16LE(index + 20) === tail.length
    ) {
      end = index;
      break;
    }
  if (end < 0) throw new Error('The archive is not a ZIP file.');
  const disk = tail.readUInt16LE(end + 4),
    directoryDisk = tail.readUInt16LE(end + 6),
    diskEntries = tail.readUInt16LE(end + 8),
    count = tail.readUInt16LE(end + 10),
    directorySize = tail.readUInt32LE(end + 12),
    directoryOffset = tail.readUInt32LE(end + 16);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== count)
    throw new Error('Multi-part archives are not supported.');
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw new Error('ZIP64 archives are not supported.');
  if (count > MAX_ENTRIES) throw new Error('The archive has too many entries.');
  if (directoryOffset + directorySize > size - tailLength + end)
    throw new Error('The archive directory is invalid.');
  const directory = readAt(descriptor, directoryOffset, directorySize);
  const entries = [],
    seen = new Set();
  let position = 0,
    unpacked = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== DIRECTORY_ENTRY)
      throw new Error('The archive directory is invalid.');
    const flags = directory.readUInt16LE(position + 8),
      method = directory.readUInt16LE(position + 10),
      crc = directory.readUInt32LE(position + 16),
      compressedSize = directory.readUInt32LE(position + 20),
      uncompressedSize = directory.readUInt32LE(position + 24),
      nameLength = directory.readUInt16LE(position + 28),
      extraLength = directory.readUInt16LE(position + 30),
      commentLength = directory.readUInt16LE(position + 32),
      entryDisk = directory.readUInt16LE(position + 34),
      attributes = directory.readUInt32LE(position + 38),
      localOffset = directory.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length || nameLength === 0 || nameLength > MAX_NAME_BYTES)
      throw new Error('Unsafe archive entry.');
    const raw = directory.subarray(position + 46, position + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    position = next;
    if (flags & 0x41) throw new Error('Encrypted archive entries are not supported.');
    if (entryDisk !== 0) throw new Error('Multi-part archives are not supported.');
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new Error('ZIP64 archives are not supported.');
    const folder = name.endsWith('/');
    const relative = folder ? name.slice(0, -1) : name;
    const segments = relative.split('/');
    const type = (attributes >>> 16) & 0o170000;
    if (
      !relative ||
      /[\\:\x00-\x1f\x7f]/.test(name) ||
      name.startsWith('/') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      type === 0o120000 ||
      (type !== 0 && type !== (folder ? 0o040000 : 0o100000))
    )
      throw new Error('Unsafe archive entry.');
    const key = relative.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('Archive path escapes or duplicates an entry.');
    seen.add(key);
    if (folder ? method !== 0 || uncompressedSize !== 0 : method !== 0 && method !== 8)
      throw new Error('Unsupported archive compression.');
    if (method === 0 && compressedSize !== uncompressedSize)
      throw new Error('The archive directory is invalid.');
    unpacked += uncompressedSize;
    if (unpacked > maximumBytes) throw new Error('Archive exceeds its expansion budget.');
    entries.push({
      name: relative,
      folder,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
  }
  // A file may not also be the parent folder of another entry.
  for (const entry of entries)
    if (!entry.folder && seen.has(entry.name.normalize('NFC').toLowerCase() + '/'))
      throw new Error('Archive path escapes or duplicates an entry.');
  const files = new Set(
    entries
      .filter((entry) => !entry.folder)
      .map((entry) => entry.name.normalize('NFC').toLowerCase()),
  );
  for (const entry of entries) {
    const parts = entry.name.normalize('NFC').toLowerCase().split('/');
    for (let depth = 1; depth < parts.length; depth++)
      if (files.has(parts.slice(0, depth).join('/')))
        throw new Error('Archive path escapes or duplicates an entry.');
  }
  return entries;
}

function entryData(descriptor, entry) {
  const header = readAt(descriptor, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_ENTRY) throw new Error('The archive entry is invalid.');
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const compressed = readAt(descriptor, start, entry.compressedSize);
  const data =
    entry.method === 0
      ? compressed
      : entry.uncompressedSize === 0
        ? Buffer.alloc(0)
        : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc)
    throw new Error('The archive entry failed its integrity check.');
  return data;
}

/**
 * Extracts every entry into `destination`, which must be an existing empty
 * folder. The whole directory is validated before the first write; an entry
 * that then fails its integrity check stops extraction, so callers extract
 * into a scratch folder and verify the result before using it.
 */
export function extractZip(archive, destination, { maximumBytes = 20 * 1024 ** 3 } = {}) {
  if (!path.isAbsolute(destination)) throw new Error('Archives extract to an absolute folder.');
  const root = path.resolve(destination);
  noLinks(root);
  if (!lstatSync(root).isDirectory() || readdirSync(root).length)
    throw new Error('Archives extract only into an empty folder.');
  const descriptor = openSync(archive, 'r');
  try {
    const entries = readDirectory(descriptor, maximumBytes);
    for (const entry of entries) {
      const target = path.join(root, ...entry.name.split('/'));
      if (!target.startsWith(root + path.sep))
        throw new Error('Archive path escapes or duplicates an entry.');
      if (entry.folder) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      noLinks(target);
      writeFileSync(target, entryData(descriptor, entry), { flag: 'wx', mode: 0o644 });
    }
    return entries.filter((entry) => !entry.folder).map((entry) => entry.name);
  } finally {
    closeSync(descriptor);
  }
}
