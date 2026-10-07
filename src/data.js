// Data layer: connects to Supabase when configured, or transparently falls back to local storage
// loaded with initial seed data so the web app runs fully out of the box.
import { createClient } from "@supabase/supabase-js";
import { SEED_UNITS, SEED_PLANS, SEED_ACTIVITY } from "./seedData.js";

const URL_ = import.meta.env.VITE_SUPABASE_URL;
const KEY_ = import.meta.env.VITE_SUPABASE_ANON_KEY;
const ADMIN_CODE = import.meta.env.VITE_ADMIN_CODE || "";

const isSupabaseConfigured = () => {
  return !!(URL_ && KEY_ && !URL_.includes("YOUR-PROJECT-REF") && !KEY_.includes("YOUR-ANON-PUBLIC-KEY"));
};

// document field -> column. `ts` lists timestamp fields (normalised to ISO strings); `nullText` maps "" <-> NULL.
const COLLECTIONS = {
  units: { table: "units", map: { name: "name", type: "type", order: "sort_order", departments: "departments", people: "people" }, ts: [] },
  plans: { table: "plans", map: { week: "week", unit: "unit_id", tasks: "tasks", wins: "wins", blockers: "blockers", asks: "asks", updatedAt: "updated_at", updatedBy: "updated_by", source: "source" }, ts: ["updatedAt"] },
  activity: { table: "activity", map: { ts: "ts", by: "by_name", unit: "unit_id", week: "week", action: "action", summary: "summary", details: "details" }, ts: ["ts"], nullText: ["week"] },
};

const fail = (error) => {
  const e = Object.assign(new Error(error.message || "Request failed"), { code: error.code || "error" });
  window.dispatchEvent(new CustomEvent("wbg-data-error", { detail: e }));
  throw e;
};

export function configError() {
  return "";
}

export function createData() {
  if (isSupabaseConfigured()) {
    return createSupabaseData();
  } else {
    return createLocalData();
  }
}

function createSupabaseData() {
  const sb = createClient(URL_, KEY_, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 5 } } });
  const live = new Map();
  const bump = (table) => (live.get(table) || new Set()).forEach((f) => f());

  const toRow = (cfg, doc) => {
    const row = {};
    for (const [k, col] of Object.entries(cfg.map)) {
      if (!(k in doc)) continue;
      let v = doc[k];
      if (cfg.nullText && cfg.nullText.includes(k) && v === "") v = null;
      row[col] = v === undefined ? null : v;
    }
    return row;
  };
  const fromRow = (cfg, row) => {
    const doc = {};
    for (const [k, col] of Object.entries(cfg.map)) {
      let v = row[col];
      if (v === undefined) continue;
      if (v === null && cfg.nullText && cfg.nullText.includes(k)) v = "";
      if (v && cfg.ts.includes(k)) v = new Date(v).toISOString();
      doc[k] = v;
    }
    return doc;
  };
  const snapDoc = (cfg, row) => ({ id: row.id, exists: true, data: () => JSON.parse(JSON.stringify(fromRow(cfg, row))) });

  const OPS = { "==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

  function query(colName, filters = [], ord = null, lim = null) {
    const cfg = COLLECTIONS[colName];
    if (!cfg) throw new Error(`Unknown collection: ${colName}`);
    const col = (f) => (f === "id" ? "id" : cfg.map[f] || f);
    const run = async () => {
      let q = sb.from(cfg.table).select("*");
      for (const [f, op, v] of filters) q = q[OPS[op]](col(f), v);
      if (ord) q = q.order(col(ord[0]), { ascending: ord[1] !== "desc" });
      if (lim) q = q.limit(lim);
      const { data, error } = await q;
      if (error) fail(error);
      const docs = (data || []).map((r) => snapDoc(cfg, r));
      return { docs, size: docs.length, empty: !docs.length };
    };
    return {
      where: (f, op, v) => query(colName, [...filters, [f, op, v]], ord, lim),
      orderBy: (f, d = "asc") => query(colName, filters, [f, d], lim),
      limit: (n) => query(colName, filters, ord, n),
      get: run,
      onSnapshot(next, onError) {
        let stopped = false, timer = null;
        const refetch = () => { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e)), 120); };
        run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e));
        if (!live.has(cfg.table)) live.set(cfg.table, new Set());
        live.get(cfg.table).add(refetch);
        const ch = sb.channel(`wbg-${cfg.table}-${Math.random().toString(36).slice(2)}`)
          .on("postgres_changes", { event: "*", schema: "public", table: cfg.table }, refetch)
          .subscribe();
        return () => { stopped = true; clearTimeout(timer); live.get(cfg.table).delete(refetch); sb.removeChannel(ch); };
      },
      doc: (id) => docRef(`${colName}/${id}`),
    };
  }

  function docRef(path) {
    const [colName, id] = path.split("/");
    const cfg = COLLECTIONS[colName];
    if (!cfg) throw new Error(`Unknown collection: ${colName}`);
    return {
      id, path,
      async get() {
        const { data, error } = await sb.from(cfg.table).select("*").eq("id", id).maybeSingle();
        if (error) fail(error);
        return data ? snapDoc(cfg, data) : { id, exists: false, data: () => undefined };
      },
      async set(doc) {
        const { error } = await sb.from(cfg.table).upsert({ id, ...toRow(cfg, doc) });
        if (error) fail(error);
        bump(cfg.table);
      },
      async update(patch) {
        const { data, error } = await sb.from(cfg.table).update(toRow(cfg, patch)).eq("id", id).select("id");
        if (error) fail(error);
        if (!data || !data.length) fail({ code: "not_found", message: "Nothing to update" });
        bump(cfg.table);
      },
      async delete() {
        const { error } = await sb.from(cfg.table).delete().eq("id", id);
        if (error) fail(error);
        bump(cfg.table);
      },
    };
  }

  const db = { doc: docRef, collection: (c) => query(c) };
  const identity = getIdentity();
  const user = getUser(identity);
  const downloads = getDownloads();

  return { db, user, downloads, identity };
}

function createLocalData() {
  const STORE_KEYS = {
    units: "wbg_local_units",
    plans: "wbg_local_plans",
    activity: "wbg_local_activity",
  };

  const SEEDS = {
    units: SEED_UNITS,
    plans: SEED_PLANS,
    activity: SEED_ACTIVITY,
  };

  const listeners = new Map();

  const getStore = (colName) => {
    const key = STORE_KEYS[colName];
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        const seed = SEEDS[colName] || [];
        localStorage.setItem(key, JSON.stringify(seed));
        return JSON.parse(JSON.stringify(seed));
      }
      return JSON.parse(raw);
    } catch (e) {
      return SEEDS[colName] || [];
    }
  };

  const setStore = (colName, items) => {
    const key = STORE_KEYS[colName];
    try {
      localStorage.setItem(key, JSON.stringify(items));
    } catch (e) {}
    notify(colName);
  };

  const notify = (colName) => {
    const set = listeners.get(colName);
    if (set) {
      set.forEach((fn) => fn());
    }
  };

  const snapDoc = (item) => ({
    id: item.id,
    exists: true,
    data: () => JSON.parse(JSON.stringify(item)),
  });

  function query(colName, filters = [], ord = null, lim = null) {
    const run = async () => {
      let items = getStore(colName);

      for (const [f, op, v] of filters) {
        items = items.filter((item) => {
          const val = item[f];
          if (op === "==") return val === v;
          if (op === "!=") return val !== v;
          if (op === ">") return val > v;
          if (op === ">=") return val >= v;
          if (op === "<") return val < v;
          if (op === "<=") return val <= v;
          return true;
        });
      }

      if (ord) {
        const [f, dir] = ord;
        items.sort((a, b) => {
          const valA = a[f] ?? "";
          const valB = b[f] ?? "";
          if (valA < valB) return dir === "desc" ? 1 : -1;
          if (valA > valB) return dir === "desc" ? -1 : 1;
          return 0;
        });
      }

      if (lim) {
        items = items.slice(0, lim);
      }

      const docs = items.map((r) => snapDoc(r));
      return { docs, size: docs.length, empty: !docs.length };
    };

    return {
      where: (f, op, v) => query(colName, [...filters, [f, op, v]], ord, lim),
      orderBy: (f, d = "asc") => query(colName, filters, [f, d], lim),
      limit: (n) => query(colName, filters, ord, n),
      get: run,
      onSnapshot(next, onError) {
        let stopped = false;
        const refetch = () => {
          if (stopped) return;
          run().then((s) => !stopped && next(s)).catch((e) => !stopped && onError && onError(e));
        };
        refetch();

        if (!listeners.has(colName)) listeners.set(colName, new Set());
        listeners.get(colName).add(refetch);

        return () => {
          stopped = true;
          listeners.get(colName)?.delete(refetch);
        };
      },
      doc: (id) => docRef(`${colName}/${id}`),
    };
  }

  function docRef(path) {
    const [colName, id] = path.split("/");
    return {
      id,
      path,
      async get() {
        const items = getStore(colName);
        const item = items.find((x) => x.id === id);
        return item ? snapDoc(item) : { id, exists: false, data: () => undefined };
      },
      async set(doc) {
        const items = getStore(colName);
        const idx = items.findIndex((x) => x.id === id);
        const record = { id, ...doc };
        if (idx >= 0) {
          items[idx] = record;
        } else {
          items.push(record);
        }
        setStore(colName, items);
      },
      async update(patch) {
        const items = getStore(colName);
        const idx = items.findIndex((x) => x.id === id);
        if (idx === -1) fail({ code: "not_found", message: "Nothing to update" });
        items[idx] = { ...items[idx], ...patch };
        setStore(colName, items);
      },
      async delete() {
        const items = getStore(colName);
        const filtered = items.filter((x) => x.id !== id);
        setStore(colName, filtered);
      },
    };
  }

  const db = { doc: docRef, collection: (c) => query(c) };
  const identity = getIdentity();
  const user = getUser(identity);
  const downloads = getDownloads();

  return { db, user, downloads, identity };
}

function getIdentity() {
  const NAME_KEY = "wbg-name", ADMIN_KEY = "wbg-admin";
  const read = (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const write = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} };
  return {
    name: () => read(NAME_KEY),
    isAdmin: () => !ADMIN_CODE || read(ADMIN_KEY) === ADMIN_CODE,
    adminRequired: () => !!ADMIN_CODE,
    set(name, code) {
      write(NAME_KEY, (name || "").trim().slice(0, 60));
      if (ADMIN_CODE) write(ADMIN_KEY, code === ADMIN_CODE ? code : "");
      return { ok: !ADMIN_CODE || code === ADMIN_CODE || !code };
    },
  };
}

function getUser(identity) {
  return {
    id: async () => identity.name(),
    isOwner: async () => identity.isAdmin(),
    profiles: async (ids) => Object.fromEntries(ids.map((i) => [i, { name: /^u_[A-Za-z0-9]{22}$/.test(i) ? "Earlier user" : i }])),
  };
}

function getDownloads() {
  return {
    async save({ filename, data }) {
      const type = /\.xlsx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : /\.pdf$/i.test(filename) ? "application/pdf" : "text/csv;charset=utf-8";
      const blob = new Blob([data], { type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
  };
}
