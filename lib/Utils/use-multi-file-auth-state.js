"use strict";
const { Mutex } = require("async-mutex");
const { readFile, writeFile, stat, mkdir, unlink } = require("fs/promises");
const { join, resolve, dirname } = require("path");
const { promisify } = require("util");
const zlib = require("zlib");
const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);
const { proto: WAProto } = require("../../WAProto");
const { initAuthCreds } = require("./auth-utils");
const { BufferJSON } = require("./generics");

const fileLocks = new Map();
const getFileLock = (filePath) => {
  let m = fileLocks.get(filePath);
  if (!m) {
    m = new Mutex();
    fileLocks.set(filePath, m);
  }
  return m;
};

const fixFileName = (file) => String(file).replace(/\/+/g, "__").replace(/:/g, "-");

async function ensureFolder(folder) {
  const info = await stat(folder).catch(() => undefined);
  if (info && !info.isDirectory()) throw new Error(`found something that is not a directory at ${folder}`);
  if (!info) await mkdir(folder, { recursive: true });
}

async function ensureParentDirForFile(path) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
}

async function readCompressedJSON(filePath) {
  const mutex = getFileLock(filePath);
  return mutex.acquire().then(async (release) => {
    try {
      const data = await readFile(filePath).catch(() => null);
      if (!data) return null;
      const inflated = await inflate(data).catch(() => null);
      if (!inflated) return null;
      const txt = inflated.toString("utf-8");
      return JSON.parse(txt, BufferJSON.reviver);
    } finally {
      release();
    }
  });
}

async function writeCompressedJSON(filePath, obj) {
  const mutex = getFileLock(filePath);
  return mutex.acquire().then(async (release) => {
    try {
      if (obj === null || obj === undefined) {
        await unlink(filePath).catch(() => {});
        return;
      }
      await ensureParentDirForFile(filePath);
      const txt = JSON.stringify(obj, BufferJSON.replacer);
      const compressed = await deflate(Buffer.from(txt, "utf-8"));
      await writeFile(filePath, compressed);
    } finally {
      release();
    }
  });
}

const CREDS_FILE = "elyn.my.id";
const CACHE_FILE = "cache.elyn";

async function useMultiFileAuthState(folderInput) {
  const folder = resolve(String(folderInput || ".")).replace(/\/+$/g, "");
  await ensureFolder(folder);

  const credsPath = join(folder, fixFileName(CREDS_FILE));
  const cachePath = join(folder, fixFileName(CACHE_FILE));

  let credsCache = null;
  let keyCache = { keys: {} };

  const ensureFileWithInitial = async (path, initial) => {
    const existing = await readCompressedJSON(path).catch(() => null);
    if (existing && typeof existing === "object") return existing;
    await writeCompressedJSON(path, initial);
    return initial;
  };

  const loadInitial = async () => {
    const initialCreds = initAuthCreds();
    const credsFromDisk = await ensureFileWithInitial(credsPath, initialCreds);
    credsCache = credsFromDisk || initialCreds;

    const initialCache = { keys: {} };
    const cacheFromDisk = await ensureFileWithInitial(cachePath, initialCache);
    keyCache = cacheFromDisk && typeof cacheFromDisk === "object" && cacheFromDisk.keys ? cacheFromDisk : initialCache;
  };

  await loadInitial();

  const saveCreds = async () => {
    const newCreds = credsCache;
    await writeCompressedJSON(credsPath, newCreds);
    credsCache = newCreds;
  };

  const convertForStorage = (value) => {
    if (value === null || value === undefined) return value;
    try {
      if (typeof value.toJSON === "function") return value.toJSON();
    } catch (e) {}
    try {
      if (typeof value.toObject === "function") return value.toObject ? value.toObject() : value;
    } catch (e) {}
    try {
      if (value && value.constructor && value.constructor.name === "Object") return value;
    } catch (e) {}
    return value;
  };

  const get = async (type, ids) => {
    if (!keyCache) {
      const cacheObj = await readCompressedJSON(cachePath).catch(() => null);
      keyCache = cacheObj && cacheObj.keys ? cacheObj : { keys: {} };
    }
    const data = {};
    await Promise.all(
      ids.map(async (id) => {
        const category = keyCache.keys[type];
        let value = category ? category[id] : null;
        if (value === undefined) value = null;
        if (type === "app-state-sync-key" && value) {
          try {
            value = WAProto.Message.AppStateSyncKeyData.fromObject(value);
          } catch (e) {}
        }
        data[id] = value;
      })
    );
    return data;
  };

  const set = async (data) => {
    const newCache = { keys: {} };
    for (const cat in keyCache.keys) {
      if (!Object.prototype.hasOwnProperty.call(keyCache.keys, cat)) continue;
      newCache.keys[cat] = {};
      for (const id in keyCache.keys[cat]) {
        if (!Object.prototype.hasOwnProperty.call(keyCache.keys[cat], id)) continue;
        newCache.keys[cat][id] = keyCache.keys[cat][id];
      }
    }

    for (const category in data) {
      if (!Object.prototype.hasOwnProperty.call(data, category)) continue;
      const ids = data[category];
      newCache.keys[category] = newCache.keys[category] || {};
      for (const id in ids) {
        if (!Object.prototype.hasOwnProperty.call(ids, id)) continue;
        const value = ids[id];
        if (value === null || value === undefined) {
          delete newCache.keys[category][id];
        } else {
          try {
            newCache.keys[category][id] = convertForStorage(value);
          } catch (e) {
            newCache.keys[category][id] = value;
          }
        }
      }
      if (Object.keys(newCache.keys[category] || {}).length === 0) {
        delete newCache.keys[category];
      }
    }

    await writeCompressedJSON(cachePath, newCache);
    keyCache = newCache;
  };

  return {
    state: {
      creds: credsCache,
      keys: {
        get,
        set,
      },
    },
    saveCreds,
  };
}

module.exports = {
  useMultiFileAuthState,
};