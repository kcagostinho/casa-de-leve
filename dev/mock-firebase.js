// Mock mínimo do SDK do Firebase para desenvolvimento local (mock.html).
// Guarda tudo em localStorage e avisa as outras abas via evento "storage",
// simulando o tempo real do Firestore. Só implementa o que app.js usa.

const KEY = "mock.firestore";
const listeners = new Set();

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function save(store) {
  localStorage.setItem(KEY, JSON.stringify(store));
  notify();
}
function notify() {
  for (const fn of [...listeners]) fn();
}
window.addEventListener("storage", (e) => { if (e.key === KEY) notify(); });

const rand = (n = 20) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const clone = (o) => JSON.parse(JSON.stringify(o));

// --- app / auth
export function initializeApp() { return {}; }
export function getAuth() { return {}; }
export function signInAnonymously() { return Promise.resolve({ user: { uid: "mock" } }); }
export function onAuthStateChanged(_auth, cb) { setTimeout(() => cb({ uid: "mock", isAnonymous: true }), 0); return () => {}; }

// --- firestore
export function initializeFirestore() { return {}; }
export function getFirestore() { return {}; }
export function persistentLocalCache() { return {}; }
export function persistentMultipleTabManager() { return {}; }

export function doc(parent, ...segs) {
  if (parent?.type === "col") {
    const id = segs[0] || rand();
    return { type: "doc", path: `${parent.path}/${id}`, id };
  }
  const path = segs.join("/");
  return { type: "doc", path, id: segs[segs.length - 1] };
}
export function collection(parent, ...segs) {
  const path = parent?.type === "doc" ? `${parent.path}/${segs.join("/")}` : segs.join("/");
  return { type: "col", path };
}
export function query(col, ...clauses) {
  const q = { type: "query", path: col.path, order: null, dir: "asc", lim: Infinity };
  for (const c of clauses) Object.assign(q, c);
  return q;
}
export const orderBy = (field, dir = "asc") => ({ order: field, dir });
export const limit = (n) => ({ lim: n });

export async function setDoc(ref, data) {
  const store = load();
  store[ref.path] = clone(data);
  save(store);
}
export async function updateDoc(ref, patch) {
  const store = load();
  if (!store[ref.path]) throw Object.assign(new Error("No document to update"), { code: "not-found" });
  const d = store[ref.path];
  for (const [k, v] of Object.entries(patch)) {
    const parts = k.split(".");
    let o = d;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts[parts.length - 1]] = clone(v);
  }
  save(store);
}
export async function getDoc(ref) {
  return docSnap(ref.path, load()[ref.path]);
}
export async function deleteDoc(ref) {
  const store = load();
  delete store[ref.path];
  save(store);
}

function docSnap(path, data) {
  return {
    id: path.split("/").pop(),
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : clone(data)),
    metadata: { fromCache: false, hasPendingWrites: false },
  };
}
function evalQuery(q) {
  const store = load();
  const depth = q.path.split("/").length + 1;
  let docs = Object.entries(store)
    .filter(([p]) => p.startsWith(q.path + "/") && p.split("/").length === depth)
    .map(([p, d]) => docSnap(p, d));
  if (q.order) {
    docs.sort((a, b) => {
      const x = a.data()?.[q.order], y = b.data()?.[q.order];
      return (x > y ? 1 : x < y ? -1 : 0) * (q.dir === "desc" ? -1 : 1);
    });
  } else {
    docs.sort((a, b) => a.id.localeCompare(b.id));
  }
  return { docs: docs.slice(0, q.lim), size: docs.length, empty: docs.length === 0, metadata: { fromCache: false, hasPendingWrites: false } };
}

export function onSnapshot(ref, next) {
  const fire = () => {
    if (ref.type === "doc") next(docSnap(ref.path, load()[ref.path]));
    else next(evalQuery(ref.type === "col" ? query(ref) : ref));
  };
  listeners.add(fire);
  setTimeout(fire, 0);
  return () => listeners.delete(fire);
}
