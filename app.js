// Casa De Leve — rateio de contas + geladeira compartilhada
// Vanilla JS + Firebase (Firestore) via CDN. Sem build.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, setDoc, updateDoc, deleteDoc, deleteField, getDoc, onSnapshot, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------------------------------------------------------------- constantes

const LS = { gid: "sede.gid", session: "sede.session", tab: "sede.tab", event: "sede.event", guest: "sede.guest" };

const CATEGORIES = {
  aluguel: { label: "Aluguel", icon: "🏠" },
  agua: { label: "Água", icon: "💧" },
  luz: { label: "Luz", icon: "💡" },
  extra: { label: "Extra", icon: "🧾" },
};
const CATEGORY_ORDER = ["aluguel", "agua", "luz", "extra"];

const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MONTHS_FULL = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// ---------------------------------------------------------------- helpers

const $ = (sel, el = document) => el.querySelector(sel);
const field = (form, name) => form.elements.namedItem(name); // form.name / form.title / elements.item colidem com props nativas
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmt = (cents) => brl.format((cents || 0) / 100);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(ym, full = false) {
  const [y, m] = ym.split("-").map(Number);
  return full ? `${MONTHS_FULL[m - 1]} de ${y}` : `${MONTHS[m - 1]}/${y}`;
}
function dateLabel(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function randomId(len = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
const pinHash = (gid, mid, pin) => sha256Hex(`${gid}:${mid}:${pin}`);

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
}

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* sem suporte */ }
    ta.remove();
    return ok;
  }
}

/** Linha com a chave Pix (de um integrante, ou de um participante de evento quando `ev` é passado). */
function pixLine(pid, ev = null) {
  const name = ev ? pName(ev, pid) : nameOf(pid);
  const pix = ev ? pPix(ev, pid) : memberById(pid)?.pix || "";
  return pixLineFor(name, pix);
}
function pixLineFor(name, pix) {
  if (!pix) return `<div class="pixline none"><span class="small muted">${esc(name)} ainda não cadastrou chave Pix</span></div>`;
  return `
    <div class="pixline">
      <span class="small muted">Pix</span>
      <code class="grow ellipsis">${esc(pix)}</code>
      <button class="btn btn-sm" data-action="copy-pix" data-pix="${esc(pix)}" data-name="${esc(name)}">Copiar</button>
    </div>`;
}

function confirmDialog(text, okLabel = "Confirmar") {
  const dlg = $("#confirm");
  $("#confirm-text").textContent = text;
  $('[data-action="confirm-yes"]', dlg).textContent = okLabel;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg._resolve = resolve;
  });
}
function settleConfirm(value) {
  const d = $("#confirm");
  const r = d._resolve;
  d._resolve = null;
  if (d.open) d.close();
  r?.(value);
}

// ---------------------------------------------------------------- estado

const state = {
  gid: null,
  group: undefined, // undefined = carregando, null = não existe
  mid: null,
  members: [],
  bills: [],
  fridge: [],
  ready: { members: false, bills: false, fridge: false },
  tab: localStorage.getItem(LS.tab) || "home",
  month: currentMonth(),
  loginPick: null, // membro selecionado na tela de login
  loginError: "",
  openDetail: null, // id da conta aberta no detalhe (para atualizar ao vivo)
  openPairs: new Set(), // duplas expandidas no dashboard (sobrevive aos re-renders)
  pendingReceipt: null, // comprovante escolhido num formulário, ainda não salvo
  unsubs: [],
  fatal: null,
  // eventos
  mode: "member", // "member" | "guest" (convidado abriu o link de um evento, sem acesso ao grupo)
  eid: null, // evento aberto em modo convidado
  guest: null, // { eid, pid } — sessão do convidado
  events: new Map(), // eid -> { id, doc, expenses, unsubs, missing }
  eventIndex: [], // índice groups/{gid}/events (modo integrante)
  openEvent: null, // evento aberto na aba Eventos (modo integrante)
  syncedParts: new Set(), // eventos em que meus dados de participante já foram sincronizados
};

const me = () => state.members.find((m) => m.id === state.mid) || null;
const memberById = (id) => state.members.find((m) => m.id === id);
const nameOf = (id) => memberById(id)?.name || state.group?.removedNames?.[id] || "?";
const activeMembers = () => state.members.filter((m) => m.active !== false);

/** Quem está agindo: o integrante logado, ou o convidado (pid) em modo convidado. */
const actorId = () => (state.mode === "guest" ? state.guest?.pid || null : state.mid);

// --- participantes de evento (integrante: pid = mid; convidado: pid próprio)
const evParts = (ev) => Object.entries(ev?.participants || {}).map(([pid, p]) => ({ pid, ...p }))
  .sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR"));
function pName(ev, pid) {
  const p = ev?.participants?.[pid];
  if (p?.member && memberById(pid)) return memberById(pid).name;
  return p?.name || nameOf(pid);
}
function pPix(ev, pid) {
  const p = ev?.participants?.[pid];
  if (p?.member && memberById(pid)) return memberById(pid).pix || "";
  return p?.pix || "";
}
const dateBR = (ymd) => (ymd ? ymd.split("-").reverse().join("/") : "");

// --- administrador: quem tem admin:true; se ninguém tem, o integrante mais antigo (o criador do grupo)
const admins = () => state.members.filter((m) => m.admin === true);
function isAdmin(mid) {
  if (!mid) return false;
  const list = admins();
  if (list.length) return list.some((m) => m.id === mid);
  const oldest = [...state.members].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  return oldest?.id === mid;
}
const amAdmin = () => isAdmin(state.mid);
function requireAdmin() {
  if (amAdmin()) return true;
  toast("Só o administrador do grupo pode fazer isso.", 3000);
  return false;
}

// ---------------------------------------------------------------- firebase

let db;

async function initFirebase() {
  if (!firebaseConfig?.apiKey || firebaseConfig.apiKey.startsWith("COLE")) {
    throw new Error("config");
  }
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    db = getFirestore(app);
  }
  await new Promise((resolve, reject) => {
    let asked = false;
    onAuthStateChanged(auth, (user) => {
      if (user) return resolve(user);
      if (asked) return;
      asked = true;
      signInAnonymously(auth).catch(reject);
    }, reject);
  });
}

const groupRef = () => doc(db, "groups", state.gid);
const col = (name) => collection(groupRef(), name);

function unsubscribeAll() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  state.ready = { members: false, bills: false, fridge: false };
  for (const eid of [...state.events.keys()]) unsubscribeEvent(eid);
}

const eventRef = (eid) => doc(db, "events", eid);
const expensesCol = (eid) => collection(db, "events", eid, "expenses");
const eventReceiptsCol = (eid) => collection(db, "events", eid, "receipts");

/** Assina events/{eid} + despesas (usado por integrantes, via índice, e por convidados). */
function subscribeEvent(eid) {
  if (state.events.has(eid)) return;
  const entry = { id: eid, doc: undefined, expenses: [], unsubs: [], missing: false };
  state.events.set(eid, entry);
  const onErr = (e) => { console.error(e); toast("Erro ao carregar evento: " + (e.code || e.message), 4000); };
  entry.unsubs.push(
    onSnapshot(eventRef(eid), (snap) => {
      if (snap.exists()) { entry.doc = snap.data(); entry.missing = false; }
      else if (!snap.metadata.fromCache) { entry.doc = null; entry.missing = true; }
      render();
    }, onErr),
    onSnapshot(query(expensesCol(eid), orderBy("createdAt", "desc")), (snap) => {
      entry.expenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, onErr),
  );
}
function unsubscribeEvent(eid) {
  const entry = state.events.get(eid);
  if (!entry) return;
  entry.unsubs.forEach((u) => u());
  state.events.delete(eid);
}
/** Eventos do grupo carregados (com doc), mais recentes primeiro. */
function groupEvents() {
  return state.eventIndex
    .map((ix) => state.events.get(ix.id))
    .filter((e) => e?.doc)
    .sort((x, y) => (y.doc.date || "").localeCompare(x.doc.date || "") || (y.doc.createdAt || 0) - (x.doc.createdAt || 0));
}

function subscribeAll() {
  unsubscribeAll();
  const onErr = (e) => {
    console.error(e);
    toast("Erro ao carregar dados: " + (e.code || e.message), 4000);
  };
  state.unsubs.push(
    onSnapshot(groupRef(), (s) => {
      if (s.exists()) state.group = s.data();
      else if (!s.metadata.fromCache) state.group = null;
      render();
    }, onErr),
    onSnapshot(col("members"), (s) => {
      state.members = s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      state.ready.members = true;
      render();
    }, onErr),
    onSnapshot(query(col("bills"), orderBy("createdAt", "desc")), (s) => {
      state.bills = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.ready.bills = true;
      render();
    }, onErr),
    onSnapshot(query(col("fridge"), orderBy("createdAt", "desc"), limit(500)), (s) => {
      state.fridge = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.item && e.qty);
      state.ready.fridge = true;
      render();
    }, onErr),
    onSnapshot(query(col("events"), orderBy("createdAt", "desc"), limit(30)), (s) => {
      state.eventIndex = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      const ids = new Set(state.eventIndex.map((e) => e.id));
      if (state.openEvent) ids.add(state.openEvent); // link de evento aberto por integrante
      for (const id of ids) subscribeEvent(id);
      for (const id of [...state.events.keys()]) if (!ids.has(id)) unsubscribeEvent(id);
      render();
    }, onErr),
  );
}

/**
 * Dispara uma escrita sem esperar a confirmação do servidor (offline-first:
 * o Firestore aplica localmente na hora e sincroniza depois). Erros chegam
 * por toast. Retorna false só se a escrita nem pôde ser iniciada.
 */
function write(fn, okMsg) {
  let p;
  try {
    p = fn();
  } catch (e) {
    console.error(e);
    toast("Não deu certo: " + (e.code || e.message), 3500);
    return false;
  }
  if (okMsg) toast(okMsg);
  Promise.resolve(p).catch((e) => {
    console.error(e);
    toast("Não foi salvo: " + (e.code || e.message), 4000);
    render();
  });
  return true;
}

// --- grupo / membros

function createGroup(name) {
  const gid = randomId(24);
  const p = setDoc(doc(db, "groups", gid), { name, createdAt: Date.now() });
  return { gid, p };
}

async function newMemberDoc(name, pin) {
  const mid = randomId(12);
  return { mid, data: { name, pinHash: await pinHash(state.gid, mid, pin), active: true, createdAt: Date.now() } };
}

async function checkPin(mid, pin) {
  const m = memberById(mid);
  return !!m && (await pinHash(state.gid, mid, pin)) === m.pinHash;
}

// --- contas

function computeShares(amount, splitAmong, paidBy, previous = {}) {
  const n = splitAmong.length;
  const base = Math.floor(amount / n);
  let rem = amount - base * n;
  // centavos sobrando vão primeiro pra quem não pagou a conta
  const order = [...splitAmong.filter((m) => m !== paidBy), ...splitAmong.filter((m) => m === paidBy)];
  const shares = {};
  for (const m of order) {
    const extra = rem > 0 ? 1 : 0;
    rem -= extra;
    const isPayer = m === paidBy;
    const prev = previous[m];
    shares[m] = {
      amount: base + extra,
      paid: isPayer ? true : !!prev?.paid,
      paidAt: isPayer ? (prev?.paidAt ?? Date.now()) : (prev?.paidAt ?? null),
      markedBy: isPayer ? null : (prev?.markedBy ?? null),
    };
  }
  return shares;
}

function saveBill(id, data) {
  const ref = id ? doc(col("bills"), id) : doc(col("bills"));
  const prev = id ? state.bills.find((b) => b.id === id) : null;
  return setDoc(ref, {
    category: data.category,
    title: data.title,
    month: data.month,
    amount: data.amount,
    paidBy: data.paidBy,
    splitAmong: data.splitAmong,
    shares: computeShares(data.amount, data.splitAmong, data.paidBy, prev?.shares || {}),
    notes: data.notes || "",
    createdBy: prev?.createdBy || state.mid,
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
}

/**
 * "Contexto" de um lançamento com cotas: uma conta do grupo ("bill:<id>") ou uma despesa
 * de evento ("ev:<eid>:<xid>"). Resolve o doc, a coleção de comprovantes e como nomear pessoas.
 */
function resolveCtx(ctx) {
  const [kind, a, b] = String(ctx || "").split(":");
  if (kind === "bill") {
    const bill = state.bills.find((x) => x.id === a);
    if (!bill) return null;
    return { ctx, kind, entry: bill, ref: doc(col("bills"), a), receipts: col("receipts"), ev: null, who: nameOf, label: `${CATEGORIES[bill.category]?.icon || "🧾"} ${esc(bill.title)} · ${monthLabel(bill.month)}` };
  }
  if (kind === "ev") {
    const e = state.events.get(a);
    const x = e?.expenses.find((y) => y.id === b);
    if (!e?.doc || !x) return null;
    return { ctx, kind, entry: x, ref: doc(db, "events", a, "expenses", b), receipts: eventReceiptsCol(a), ev: e.doc, eid: a, who: (pid) => pName(e.doc, pid), label: `🍖 ${esc(e.doc.name)} · ${esc(x.title)}` };
  }
  return null;
}

function toggleShare(ctx, pid) {
  const c = resolveCtx(ctx);
  const share = c?.entry.shares?.[pid];
  if (!c || !share || pid === c.entry.paidBy) return Promise.resolve();
  const paid = !share.paid;
  if (!paid) deleteReceipt(share.receiptId, c.receipts);
  return updateDoc(c.ref, {
    [`shares.${pid}.paid`]: paid,
    [`shares.${pid}.paidAt`]: paid ? Date.now() : null,
    [`shares.${pid}.markedBy`]: paid ? actorId() : null,
    [`shares.${pid}.receiptId`]: paid ? (share.receiptId || null) : null,
  });
}

/** Apaga um lançamento (conta ou despesa) e os comprovantes das cotas (best-effort). */
function deleteLedger(ctx) {
  const c = resolveCtx(ctx);
  if (!c) return Promise.resolve();
  for (const s of Object.values(c.entry.shares || {})) deleteReceipt(s.receiptId, c.receipts);
  return deleteDoc(c.ref);
}
const deleteBill = (bill) => deleteLedger("bill:" + bill.id);

function duplicateBill(bill) {
  const month = addMonths(bill.month, 1);
  const split = bill.splitAmong.filter((m) => memberById(m)?.active !== false);
  const splitAmong = split.includes(bill.paidBy) ? split : [...split, bill.paidBy];
  return saveBill(null, { ...bill, month, splitAmong, notes: "" });
}

// --- comprovantes (guardados comprimidos dentro do Firestore; sem Firebase Storage)

const RECEIPT_MAX_DATAURL = 700_000; // chars (~525 KB); doc do Firestore aguenta 1 MiB
const PDF_MAX_BYTES = 600 * 1024;

function pickFile() {
  const input = $("#filepick");
  return new Promise((resolve) => {
    input.value = "";
    const done = (f) => { input.onchange = null; input.oncancel = null; resolve(f); };
    input.onchange = () => done(input.files?.[0] || null);
    input.oncancel = () => done(null);
    input.click();
  });
}

async function compressImage(file) {
  let img = await createImageBitmap(file).catch(() => null);
  if (!img) {
    img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = URL.createObjectURL(file);
    });
  }
  const w0 = img.width, h0 = img.height;
  let out = "";
  for (const [max, q] of [[1280, 0.75], [1024, 0.6], [800, 0.5], [640, 0.4]]) {
    const scale = Math.min(1, max / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    out = canvas.toDataURL("image/jpeg", q);
    if (out.length <= RECEIPT_MAX_DATAURL) break;
  }
  return { dataUrl: out, mime: "image/jpeg", bytes: Math.round((out.length - out.indexOf(",") - 1) * 0.75), name: file.name || "imagem.jpg" };
}

async function readPdf(file) {
  if (file.size > PDF_MAX_BYTES) throw new Error("PDF muito grande (máx. 600 KB). Tire um print do comprovante.");
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  return { dataUrl, mime: "application/pdf", bytes: file.size, name: file.name || "comprovante.pdf" };
}

/** Abre o seletor de arquivo e devolve {dataUrl, mime, bytes, name} pronto pra salvar, ou null se cancelou. */
async function pickAndCompressReceipt() {
  const file = await pickFile();
  if (!file) return null;
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return readPdf(file);
  toast("Processando imagem…", 1500);
  try {
    return await compressImage(file);
  } catch {
    throw new Error("Não consegui ler esse arquivo. Envie um print (imagem).");
  }
}

/** Grava o comprovante na coleção indicada e devolve o id (escrita fire-and-forget). */
function saveReceipt(payload, receipts = col("receipts")) {
  const rid = randomId(16);
  write(() => setDoc(doc(receipts, rid), { ...payload, uploadedBy: actorId(), createdAt: Date.now() }));
  return rid;
}
function deleteReceipt(rid, receipts = col("receipts")) {
  if (rid) deleteDoc(doc(receipts, rid)).catch(() => {});
}

async function openReceipt(rid, ctx) {
  const c = resolveCtx(ctx);
  const receipts = c ? c.receipts : col("receipts");
  const who = c ? c.who : nameOf;
  openDialog(`<div class="sheet"><button class="close" data-action="dlg-close" aria-label="Fechar">✕</button><h2>Comprovante</h2><p class="muted center">Carregando…</p></div>`);
  let snap = null;
  try { snap = await getDoc(doc(receipts, rid)); } catch (e) { console.error(e); }
  if (!snap?.exists()) {
    return openDialog(`<div class="sheet"><button class="close" data-action="dlg-close" aria-label="Fechar">✕</button><h2>Comprovante</h2><p class="muted">Não encontrado — pode ter sido apagado.</p></div>`);
  }
  const r = snap.data();
  state.receiptView = r;
  const meta = `Enviado por ${esc(who(r.uploadedBy))} em ${dateLabel(r.createdAt)} · ${Math.max(1, Math.round((r.bytes || 0) / 1024))} KB`;
  openDialog(`
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>Comprovante</h2>
      <p class="muted small">${meta}</p>
      ${r.mime === "application/pdf"
        ? `<button class="btn btn-primary btn-block" data-action="open-pdf">📄 Abrir PDF</button>`
        : `<img class="receipt-img" src="${r.dataUrl}" alt="Comprovante">`}
    </div>`);
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = head.match(/data:(.*?);/)?.[1] || "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Anexa (ou troca) o comprovante de uma cota e marca como paga. */
function attachReceiptToShare(ctx, pid, payload) {
  const c = resolveCtx(ctx);
  const share = c?.entry.shares?.[pid];
  if (!c || !share) return;
  deleteReceipt(share.receiptId, c.receipts);
  const rid = saveReceipt(payload, c.receipts);
  write(() => updateDoc(c.ref, {
    [`shares.${pid}.paid`]: true,
    [`shares.${pid}.paidAt`]: share.paidAt || Date.now(),
    [`shares.${pid}.markedBy`]: share.markedBy || actorId(),
    [`shares.${pid}.receiptId`]: rid,
  }), "Comprovante anexado");
}

// --- geladeira (por item: "Pedro pegou 2× Heineken do Kaique")

const itemKeyOf = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

function addFridgeEntry({ kind, from, to, item, qty, note }) {
  return setDoc(doc(col("fridge")), {
    kind, from, to,
    item: String(item).trim(),
    itemKey: itemKeyOf(item),
    qty: Math.max(1, Math.round(qty)),
    note: note || "",
    createdBy: state.mid,
    createdAt: Date.now(),
  });
}

/**
 * Saldos de itens por dupla: Map "a|b" -> Map itemKey -> {label, net}, com a < b e
 * net > 0 => a deve b. Item "fluiu" de `from` para `to`: `to` passa a dever `from`.
 */
function itemBalances() {
  const pairs = new Map();
  const entries = [...state.fridge].sort((x, y) => x.createdAt - y.createdAt);
  for (const e of entries) {
    const [a, b] = [e.from, e.to].sort();
    const key = `${a}|${b}`;
    if (!pairs.has(key)) pairs.set(key, new Map());
    const items = pairs.get(key);
    const it = items.get(e.itemKey) || { label: e.item, net: 0 };
    it.label = bestLabel(e.itemKey);
    it.net += e.to === a ? e.qty : -e.qty;
    items.set(e.itemKey, it);
  }
  for (const [key, items] of pairs) {
    for (const [k, it] of items) if (it.net === 0) items.delete(k);
    if (items.size === 0) pairs.delete(key);
  }
  return pairs;
}

/** Grafia mais usada de um item (empate: a que tem maiúscula). */
function bestLabel(itemKey) {
  const n = new Map();
  for (const e of state.fridge) if (e.itemKey === itemKey) n.set(e.item, (n.get(e.item) || 0) + 1);
  return [...n.entries()].sort((x, y) => y[1] - x[1] || (/^[A-ZÀ-Ú]/.test(y[0]) - /^[A-ZÀ-Ú]/.test(x[0])))[0]?.[0] || itemKey;
}

/** Do ponto de vista de `mid`: [{ other, iOwe: [{key,label,qty}], theyOwe: [...] }] */
function itemBalancesFor(mid) {
  const out = [];
  for (const [key, items] of itemBalances()) {
    const [a, b] = key.split("|");
    if (a !== mid && b !== mid) continue;
    const row = { other: a === mid ? b : a, iOwe: [], theyOwe: [] };
    for (const [k, it] of items) {
      const mine = a === mid ? it.net : -it.net; // > 0 => eu devo
      (mine > 0 ? row.iOwe : row.theyOwe).push({ key: k, label: it.label, qty: Math.abs(mine) });
    }
    out.push(row);
  }
  return out.sort((x, y) => nameOf(x.other).localeCompare(nameOf(y.other), "pt-BR"));
}

const fmtItems = (list) => list.map((i) => `${i.qty}× ${esc(i.label)}`).join(", ");
const fmtItemsPlain = (list) => list.map((i) => `${i.qty}× ${i.label}`).join(", ");

// --- dashboard: contas (R$) + geladeira (itens) por dupla

/**
 * [{ a, b, moneyNet, shares, items }] — moneyNet > 0 ⇒ a deve b (só contas);
 * shares[].signed relativo a a→b; items[].net > 0 ⇒ a deve b (quantidades).
 */
function consolidated() {
  const pairs = new Map();
  const get = (x, y) => {
    const [a, b] = [x, y].sort();
    const key = `${a}|${b}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, moneyNet: 0, shares: [], items: [] });
    return pairs.get(key);
  };
  const addShares = (entry, ctx, label, onlyMembers) => {
    for (const [pid, s] of Object.entries(entry.shares || {})) {
      if (pid === entry.paidBy || s.paid) continue;
      if (onlyMembers && !(memberById(pid) && memberById(entry.paidBy))) continue; // convidados ficam só no evento
      const p = get(pid, entry.paidBy);
      const signed = pid === p.a ? s.amount : -s.amount;
      p.moneyNet += signed;
      p.shares.push({ from: pid, to: entry.paidBy, amount: s.amount, signed, ctx, label });
    }
  };
  for (const bl of state.bills) {
    addShares(bl, "bill:" + bl.id, `${CATEGORIES[bl.category]?.icon || "🧾"} ${esc(bl.title)} · ${monthLabel(bl.month)}`, false);
  }
  for (const e of groupEvents()) {
    for (const x of e.expenses) addShares(x, `ev:${e.id}:${x.id}`, `🍖 ${esc(e.doc.name)} · ${esc(x.title)}`, true);
  }
  for (const [key, items] of itemBalances()) {
    const [a, b] = key.split("|");
    const p = get(a, b);
    for (const [k, it] of items) p.items.push({ key: k, label: it.label, net: it.net });
  }
  return [...pairs.values()]
    .filter((p) => p.moneyNet !== 0 || p.shares.length || p.items.length)
    .sort((x, y) => Math.abs(y.moneyNet) - Math.abs(x.moneyNet));
}

/** Uma dupla vista por `mid`: money > 0 ⇒ eu devo; iOwe/theyOwe são itens com qty. */
function pairView(p, mid) {
  const isA = p.a === mid;
  const rel = (n) => (isA ? n : -n);
  return {
    other: isA ? p.b : p.a,
    money: rel(p.moneyNet),
    iOwe: p.items.filter((it) => rel(it.net) > 0).map((it) => ({ ...it, qty: Math.abs(it.net) })),
    theyOwe: p.items.filter((it) => rel(it.net) < 0).map((it) => ({ ...it, qty: Math.abs(it.net) })),
    shares: p.shares.map((s) => ({ ...s, signed: rel(s.signed) })),
  };
}

const findPair = (a, b) => consolidated().find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));

/** Quita em dinheiro: marca todas as cotas pendentes entre os dois (nos dois sentidos), contas e eventos. */
function settlePair(p, receiptId) {
  const now = Date.now();
  const debtor = p.moneyNet >= 0 ? p.a : p.b;
  const byCtx = new Map();
  for (const s of p.shares) {
    const upd = byCtx.get(s.ctx) || {};
    upd[`shares.${s.from}.paid`] = true;
    upd[`shares.${s.from}.paidAt`] = now;
    upd[`shares.${s.from}.markedBy`] = actorId();
    upd[`shares.${s.from}.receiptId`] = s.from === debtor ? (receiptId || null) : null;
    byCtx.set(s.ctx, upd);
  }
  for (const [ctx, upd] of byCtx) {
    const c = resolveCtx(ctx);
    if (c) write(() => updateDoc(c.ref, upd));
  }
}

/** Pares netos DENTRO de um evento (keyed por pid), mesmo formato de consolidated(). */
function eventPairs(entry) {
  const pairs = new Map();
  for (const x of entry.expenses) {
    for (const [pid, s] of Object.entries(x.shares || {})) {
      if (pid === x.paidBy || s.paid) continue;
      const [a, b] = [pid, x.paidBy].sort();
      const key = `${a}|${b}`;
      if (!pairs.has(key)) pairs.set(key, { a, b, moneyNet: 0, shares: [], items: [] });
      const p = pairs.get(key);
      const signed = pid === a ? s.amount : -s.amount;
      p.moneyNet += signed;
      p.shares.push({ from: pid, to: x.paidBy, amount: s.amount, signed, ctx: `ev:${entry.id}:${x.id}`, label: `🍖 ${esc(x.title)}` });
    }
  }
  return [...pairs.values()].filter((p) => p.moneyNet !== 0 || p.shares.length).sort((x, y) => Math.abs(y.moneyNet) - Math.abs(x.moneyNet));
}
const findEventPair = (eid, a, b) => {
  const e = state.events.get(eid);
  return e ? eventPairs(e).find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a)) : null;
};

// --- eventos: CRUD

function createEvent(name, date) {
  const eid = randomId(24);
  const m = me();
  const participants = { [state.mid]: { name: m.name, member: true, pix: m.pix || "" } };
  write(() => setDoc(eventRef(eid), { name, date, createdAt: Date.now(), createdBy: state.mid, closed: false, participants }));
  write(() => setDoc(doc(col("events"), eid), { name, date, createdAt: Date.now() }), "Evento criado");
  return eid;
}
function updateEventMeta(eid, data) {
  write(() => updateDoc(eventRef(eid), data));
  if (state.gid) write(() => updateDoc(doc(col("events"), eid), data), "Evento atualizado");
}
function deleteEvent(entry) {
  for (const x of entry.expenses) deleteLedger(`ev:${entry.id}:${x.id}`);
  write(() => deleteDoc(eventRef(entry.id)));
  write(() => deleteDoc(doc(col("events"), entry.id)), "Evento excluído");
}
function addParticipants(eid, list) {
  const upd = {};
  for (const p of list) upd[`participants.${p.pid}`] = { name: p.name, member: !!p.member, pix: p.pix || "" };
  return updateDoc(eventRef(eid), upd);
}
function removeParticipant(eid, pid) {
  return updateDoc(eventRef(eid), { [`participants.${pid}`]: deleteField() });
}
/** Mantém meus dados de participante (nome/Pix) em dia no evento — uma vez por evento por sessão. */
function syncMyParticipant(entry) {
  const m = me();
  const p = entry.doc?.participants?.[state.mid];
  if (!m || !p || state.syncedParts.has(entry.id)) return;
  state.syncedParts.add(entry.id);
  if (p.name !== m.name || (p.pix || "") !== (m.pix || "")) {
    updateDoc(eventRef(entry.id), { [`participants.${state.mid}.name`]: m.name, [`participants.${state.mid}.pix`]: m.pix || "" }).catch(() => {});
  }
}
function saveExpense(eid, xid, data) {
  const entry = state.events.get(eid);
  const ref = xid ? doc(expensesCol(eid), xid) : doc(expensesCol(eid));
  const prev = xid ? entry?.expenses.find((x) => x.id === xid) : null;
  return setDoc(ref, {
    title: data.title,
    amount: data.amount,
    paidBy: data.paidBy,
    splitAmong: data.splitAmong,
    shares: computeShares(data.amount, data.splitAmong, data.paidBy, prev?.shares || {}),
    notes: data.notes || "",
    createdBy: prev?.createdBy || actorId(),
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
}
const eventLink = (eid) => `${location.origin}${location.pathname}#e=${eid}`;

function buildEventMessage(entry) {
  const ev = entry.doc;
  const total = entry.expenses.reduce((a, x) => a + x.amount, 0);
  const lines = [`🍖 *${ev.name}* — ${dateBR(ev.date)}`, `Total: ${fmt(total)} · ${evParts(ev).length} pessoas`];
  for (const x of entry.expenses) lines.push(`• ${x.title}: ${fmt(x.amount)} (pagou ${pName(ev, x.paidBy)})`);
  const pairs = eventPairs(entry);
  lines.push("");
  if (!pairs.length) lines.push("✅ Todo mundo acertado! 🎉");
  else {
    lines.push("⏳ *Falta pagar:*");
    const creditors = new Set();
    for (const p of pairs) {
      const d = p.moneyNet > 0 ? p.a : p.b, c = p.moneyNet > 0 ? p.b : p.a;
      lines.push(`• ${pName(ev, d)} → ${pName(ev, c)}: ${fmt(Math.abs(p.moneyNet))}`);
      creditors.add(c);
    }
    const pix = [...creditors].filter((c) => pPix(ev, c)).map((c) => `💠 Pix ${pName(ev, c)}: ${pPix(ev, c)}`);
    if (pix.length) lines.push("", ...pix);
  }
  return lines.join("\n");
}

// --- mensagens pro WhatsApp (texto puro, sem HTML)

const groupTitle = () => state.group?.name || "Casa De Leve";

function buildMonthMessage(month) {
  const bills = state.bills.filter((b) => b.month === month);
  const lines = [`🏠 *${groupTitle()}* — ${cap(monthLabel(month, true))}`];
  if (!bills.length) return lines.concat("Nenhuma conta lançada neste mês.").join("\n");
  const total = bills.reduce((a, b) => a + b.amount, 0);
  lines.push(`Contas do mês: ${fmt(total)}`);
  for (const b of bills) lines.push(`• ${CATEGORIES[b.category]?.icon || "🧾"} ${b.title}: ${fmt(b.amount)} (pagou ${nameOf(b.paidBy)})`);

  const pending = new Map(); // "debtor|creditor" -> {debtor, creditor, amount, titles}
  const paidUp = new Set();
  for (const b of bills) {
    for (const [mid, s] of Object.entries(b.shares || {})) {
      if (mid === b.paidBy) continue;
      if (s.paid) { paidUp.add(mid); continue; }
      const k = `${mid}|${b.paidBy}`;
      const p = pending.get(k) || { debtor: mid, creditor: b.paidBy, amount: 0, titles: [] };
      p.amount += s.amount;
      p.titles.push(b.title);
      pending.set(k, p);
    }
  }
  lines.push("");
  if (!pending.size) {
    lines.push("✅ Todo mundo pagou! 🎉");
    return lines.join("\n");
  }
  lines.push("⏳ *Falta pagar:*");
  for (const p of [...pending.values()].sort((x, y) => y.amount - x.amount)) {
    lines.push(`• ${nameOf(p.debtor)} → ${nameOf(p.creditor)}: ${fmt(p.amount)} (${p.titles.join(", ")})`);
  }
  const debtors = new Set([...pending.values()].map((p) => p.debtor));
  const ok = [...paidUp].filter((m) => !debtors.has(m)).map(nameOf);
  if (ok.length) lines.push(`✅ Em dia: ${ok.join(", ")}`);
  const creditors = [...new Set([...pending.values()].map((p) => p.creditor))].filter((c) => memberById(c)?.pix);
  if (creditors.length) {
    lines.push("");
    for (const c of creditors) lines.push(`💠 Pix ${nameOf(c)}: ${memberById(c).pix}`);
  }
  return lines.join("\n");
}

function buildGeneralMessage() {
  const pairs = consolidated();
  const lines = [`🏠 *${groupTitle()}* — resumo de ${new Date().toLocaleDateString("pt-BR")}`];
  const money = [], items = [], creditors = new Set();
  for (const p of pairs) {
    if (p.moneyNet !== 0) {
      const d = p.moneyNet > 0 ? p.a : p.b, c = p.moneyNet > 0 ? p.b : p.a;
      money.push(`• ${nameOf(d)} → ${nameOf(c)}: ${fmt(Math.abs(p.moneyNet))}`);
      creditors.add(c);
    }
    const aOwes = p.items.filter((i) => i.net > 0).map((i) => ({ label: i.label, qty: i.net }));
    const bOwes = p.items.filter((i) => i.net < 0).map((i) => ({ label: i.label, qty: -i.net }));
    if (aOwes.length) items.push(`• ${nameOf(p.a)} deve ${fmtItemsPlain(aOwes)} pra ${nameOf(p.b)}`);
    if (bOwes.length) items.push(`• ${nameOf(p.b)} deve ${fmtItemsPlain(bOwes)} pra ${nameOf(p.a)}`);
  }
  lines.push("", "💸 *Contas:*", ...(money.length ? money : ["✅ Ninguém deve nada"]));
  lines.push("", "🍺 *Geladeira:*", ...(items.length ? items : ["✅ Tudo zerado"]));
  const pix = [...creditors].filter((c) => memberById(c)?.pix).map((c) => `💠 Pix ${nameOf(c)}: ${memberById(c).pix}`);
  if (pix.length) lines.push("", ...pix);
  return lines.join("\n");
}

function openShareDialog(title, text) {
  state.shareText = text;
  openDialog(`
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${esc(title)}</h2>
      <p class="small muted">Prévia da mensagem. Cole no grupo do WhatsApp.</p>
      <textarea class="msg" readonly rows="12">${esc(text)}</textarea>
      <div class="actions">
        <button class="btn" data-action="share-copy">Copiar</button>
        <button class="btn btn-primary" data-action="share-wa">${navigator.share ? "Compartilhar" : "Abrir no WhatsApp"}</button>
      </div>
    </div>`);
}

// ---------------------------------------------------------------- sessão

function saveSession() {
  localStorage.setItem(LS.session, JSON.stringify({ gid: state.gid, mid: state.mid }));
  localStorage.setItem(LS.tab, state.tab);
}
function logout() {
  state.mid = null;
  state.loginPick = null;
  localStorage.removeItem(LS.session);
  render();
}
function inviteLink() {
  return `${location.origin}${location.pathname}#g=${state.gid}`;
}

// ---------------------------------------------------------------- boot

async function boot() {
  const m = location.hash.match(/g=([A-Za-z0-9]{8,})/);
  if (m) {
    const gid = m[1];
    if (gid !== localStorage.getItem(LS.gid)) localStorage.removeItem(LS.session);
    localStorage.setItem(LS.gid, gid);
    localStorage.removeItem(LS.event);
    history.replaceState(null, "", location.pathname + location.search);
  }
  const em = location.hash.match(/e=([A-Za-z0-9]{8,})/);
  if (em) {
    localStorage.setItem(LS.event, em[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
  state.gid = localStorage.getItem(LS.gid);
  const pendingEvent = localStorage.getItem(LS.event);

  try {
    await initFirebase();
  } catch (e) {
    console.error(e);
    state.fatal = e.message === "config" ? "config" : "conn";
    render();
    return;
  }

  const sess = JSON.parse(localStorage.getItem(LS.session) || "null");
  if (state.gid && sess?.gid === state.gid) state.mid = sess.mid;

  if (state.gid && state.mid) {
    // integrante logado: link de evento abre na aba Eventos
    if (pendingEvent) {
      state.tab = "events";
      state.openEvent = pendingEvent;
      localStorage.removeItem(LS.event);
    }
    subscribeAll();
  } else if (pendingEvent && (em || !state.gid)) {
    // convidado (ou aparelho sem grupo): só o evento
    state.mode = "guest";
    state.eid = pendingEvent;
    const g = JSON.parse(localStorage.getItem(LS.guest) || "null");
    if (g?.eid === pendingEvent) state.guest = g;
    subscribeEvent(pendingEvent);
  } else if (state.gid) {
    subscribeAll();
  }
  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

// ---------------------------------------------------------------- render

function render() {
  const root = $("#root");
  const tabbar = $("#tabbar");

  // não recriar a tela enquanto a pessoa digita num campo de texto fora de dialog
  const ae = document.activeElement;
  if (ae && root.contains(ae) && ae.matches("input:not([type=checkbox]):not([type=radio]), textarea, select")) return;

  tabbar.hidden = true;

  if (state.fatal === "config") {
    root.innerHTML = `
      <div class="logo">🍻</div>
      <h1 class="center" style="padding:0">Casa De Leve</h1>
      <div class="card">
        <h2>Falta configurar o Firebase</h2>
        <p class="muted mb0">O arquivo <code>firebase-config.js</code> ainda está com o valor de exemplo. Cole ali o objeto <code>firebaseConfig</code> do console do Firebase e recarregue.</p>
      </div>`;
    return;
  }
  if (state.fatal === "conn") {
    root.innerHTML = `
      <div class="logo">📡</div>
      <div class="card">
        <h2>Sem conexão</h2>
        <p class="muted">Na primeira vez o app precisa de internet. Conecte e tente de novo.</p>
        <button class="btn btn-primary btn-block" data-action="reload">Tentar de novo</button>
      </div>`;
    return;
  }
  if (state.mode === "guest") return renderGuest(root);
  if (!state.gid) return renderSetup(root);
  if (state.group === null) return renderGroupMissing(root);
  if (!state.ready.members || state.group === undefined) {
    root.innerHTML = `<div class="center muted">Carregando…</div>`;
    return;
  }
  if (!me()) return renderLogin(root);

  // o admin implícito (mais antigo, quando ninguém tem a flag) grava a flag pra si — uma vez
  if (!admins().length && amAdmin() && !state.adminHealed) {
    state.adminHealed = true;
    write(() => updateDoc(doc(col("members"), state.mid), { admin: true }));
  }
  tabbar.hidden = false;
  tabbar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  const views = { home: renderHome, bills: renderBills, fridge: renderFridge, events: renderEvents, people: renderPeople };
  root.innerHTML = topbar() + (views[state.tab] || renderHome)();
  refreshOpenDetail();
}

/** Re-renderiza o detalhe (conta ou despesa) aberto no dialog, se houver. */
function refreshOpenDetail() {
  if (!state.openDetail || !$("#dlg").open) return;
  const c = resolveCtx(state.openDetail);
  if (!c) return closeDialog();
  $("#dlg").innerHTML = c.kind === "bill" ? billDetailHtml(c.entry) : expenseDetailHtml(state.events.get(c.eid), c.entry);
}

// --- modo convidado (link de evento, sem acesso ao grupo)

function renderGuest(root) {
  const entry = state.events.get(state.eid);
  if (!entry || entry.doc === undefined) { root.innerHTML = `<div class="center muted">Carregando…</div>`; return; }
  if (entry.missing || !entry.doc) {
    root.innerHTML = `
      <div class="logo">🤔</div>
      <div class="card">
        <h2>Evento não encontrado</h2>
        <p class="muted">O link que você abriu não corresponde a nenhum evento — pode ter sido excluído. Confira com quem te mandou.</p>
        <button class="btn btn-block" data-action="guest-exit">Sair</button>
      </div>`;
    return;
  }
  const ev = entry.doc;
  const pid = state.guest?.pid;
  if (!pid || !ev.participants?.[pid]) {
    const parts = evParts(ev);
    root.innerHTML = `
      <div class="logo">🍖</div>
      <h1 class="center" style="padding:0">${esc(ev.name)}</h1>
      <p class="center muted" style="padding:0 0 16px">${dateBR(ev.date)} · Quem é você?</p>
      <div class="btn-list">
        ${parts.map((p) => `<button class="btn" data-action="guest-pick" data-id="${p.pid}"><span class="avatar">${esc(initials(p.name))}</span>${esc(p.name)}</button>`).join("")}
      </div>
      <p class="center small muted mt">Não está na lista? Peça pra quem organizou te adicionar.</p>`;
    return;
  }
  root.innerHTML = `
    <div class="topbar">
      <div>
        <h1>🍖 ${esc(ev.name)}</h1>
        <div class="who">${dateBR(ev.date)} · Você é <b>${esc(pName(ev, pid))}</b> · <button class="link small" data-action="guest-switch">trocar</button></div>
      </div>
      <div class="avatar">${esc(initials(pName(ev, pid)))}</div>
    </div>
    ${eventDetailHtml(entry, { guest: true })}`;
  refreshOpenDetail();
}

function topbar() {
  const m = me();
  return `
    <div class="topbar">
      <div>
        <h1>${esc(state.group?.name || "Casa De Leve")}</h1>
        <div class="who">Você é <b>${esc(m.name)}</b></div>
      </div>
      <div class="avatar">${esc(initials(m.name))}</div>
    </div>`;
}

// --- telas iniciais

function renderSetup(root) {
  root.innerHTML = `
    <div class="logo">🍻</div>
    <h1 class="center" style="padding:0 0 4px">Casa De Leve</h1>
    <p class="center muted" style="padding:0 0 20px">Rateio das contas do espaço e controle da geladeira.</p>
    <div class="card">
      <h2>Criar um grupo novo</h2>
      <form data-form="create-group">
        <label class="field"><span>Nome do grupo</span>
          <input type="text" name="name" required maxlength="40" placeholder="Ex.: Casa De Leve" value="Casa De Leve" autocomplete="off">
        </label>
        <button class="btn btn-primary btn-block" type="submit">Criar grupo</button>
      </form>
    </div>
    <div class="card">
      <h2>Já existe um grupo?</h2>
      <p class="muted mb0">Peça o <b>link de convite</b> pra quem criou e abra ele aqui no celular. O link já entra direto no grupo.</p>
    </div>`;
}

function renderGroupMissing(root) {
  root.innerHTML = `
    <div class="logo">🤔</div>
    <div class="card">
      <h2>Grupo não encontrado</h2>
      <p class="muted">O link que você abriu não corresponde a nenhum grupo. Confira com quem te mandou.</p>
      <button class="btn btn-block" data-action="forget-group">Criar um grupo novo</button>
    </div>`;
}

function renderLogin(root) {
  const members = activeMembers();
  if (state.loginPick && memberById(state.loginPick)) {
    const m = memberById(state.loginPick);
    root.innerHTML = `
      <div class="logo">🔑</div>
      <h1 class="center" style="padding:0">${esc(state.group.name)}</h1>
      <div class="card">
        <h2>Oi, ${esc(m.name)}! Digite seu PIN</h2>
        <form data-form="login">
          <input class="pin" type="password" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="PIN">
          ${state.loginError ? `<div class="error">${esc(state.loginError)}</div>` : ""}
          <div class="actions">
            <button class="btn btn-ghost" type="button" data-action="login-back">Voltar</button>
            <button class="btn btn-primary" type="submit">Entrar</button>
          </div>
        </form>
      </div>`;
    setTimeout(() => $("input.pin", root)?.focus(), 50);
    return;
  }
  root.innerHTML = `
    <div class="logo">🍻</div>
    <h1 class="center" style="padding:0">${esc(state.group.name)}</h1>
    <p class="center muted" style="padding:0 0 16px">Quem é você?</p>
    <div class="btn-list">
      ${members.map((m) => `<button class="btn" data-action="login-pick" data-id="${m.id}"><span class="avatar">${esc(initials(m.name))}</span>${esc(m.name)}</button>`).join("")}
    </div>
    ${members.length === 0 ? `<div class="card mt"><p class="muted mb0">Ninguém cadastrado ainda. Seja o primeiro!</p></div>` : ""}
    <div class="center"><button class="link" data-action="signup">${members.length ? "Sou novo aqui — me cadastrar" : "Cadastrar o primeiro integrante"}</button></div>`;
}

// --- Início

function renderHome() {
  const pairs = consolidated();
  const mine = pairs
    .filter((p) => p.a === state.mid || p.b === state.mid)
    .map((p) => ({ p, v: pairView(p, state.mid) }))
    // primeiro o que eu devo, depois o que me devem, depois só itens
    .sort((x, y) => (y.v.money > 0) - (x.v.money > 0) || Math.abs(y.v.money) - Math.abs(x.v.money));
  const others = pairs.filter((p) => p.a !== state.mid && p.b !== state.mid);
  const totalOwe = mine.reduce((acc, { v }) => acc + Math.max(0, v.money), 0);
  const totalOwed = mine.reduce((acc, { v }) => acc + Math.max(0, -v.money), 0);

  return `
    ${setupCard()}
    <div class="strip">
      <div class="strip-item"><span class="small muted">Você deve</span><b class="${totalOwe ? "danger" : ""}">${fmt(totalOwe)}</b></div>
      <div class="strip-item"><span class="small muted">Te devem</span><b class="${totalOwed ? "ok" : ""}">${fmt(totalOwed)}</b></div>
    </div>
    <div class="share-row"><button class="btn btn-sm" data-action="share-general">📤 Compartilhar resumo</button></div>
    ${mine.length ? mine.map(({ p, v }) => debtCard(p, v)).join("") : `<div class="card"><div class="empty"><div class="big">🍻</div>Você não deve ninguém e ninguém te deve.</div></div>`}
    ${others.length ? `
    <div class="card">
      <details data-pair="__others" ${state.openPairs.has("__others") ? "open" : ""}>
        <summary>Entre os outros (${others.length})</summary>
        ${others.map(otherPairRow).join("")}
      </details>
    </div>` : ""}
    ${monthCard()}`;
}

/** Avisos do que falta configurar (responsável, meu Pix). */
function setupCard() {
  const rows = [];
  if (!state.group?.treasurer || !memberById(state.group.treasurer)) {
    rows.push(amAdmin()
      ? `<div class="row"><div class="grow">💰 Ninguém definido como responsável pelas contas</div><button class="btn btn-sm" data-action="pick-treasurer">Definir</button></div>`
      : `<div class="row"><div class="grow">💰 Ninguém definido como responsável pelas contas — peça ao administrador</div></div>`);
  }
  if (!me()?.pix) {
    rows.push(`<div class="row"><div class="grow">💠 Você ainda não cadastrou sua chave Pix</div><button class="btn btn-sm" data-action="member-pix">Cadastrar</button></div>`);
  }
  return rows.length ? `<div class="card setup"><h2>Falta configurar</h2>${rows.join("")}</div>` : "";
}

function debtCard(p, v) {
  const key = `${p.a}|${p.b}`;
  const cls = v.money > 0 ? "debt-owe" : v.money < 0 ? "debt-owed" : "debt-items";
  const head = v.money > 0 ? "Você deve pra" : v.money < 0 ? "Te deve" : "Só itens da geladeira";
  const itemsLine = v.iOwe.length || v.theyOwe.length ? `
    <div class="items-line">🍺 ${v.iOwe.length ? `você deve <b>${fmtItems(v.iOwe)}</b>` : ""}${v.iOwe.length && v.theyOwe.length ? " · " : ""}${v.theyOwe.length ? `${esc(nameOf(v.other))} te deve <b>${fmtItems(v.theyOwe)}</b>` : ""}</div>` : "";
  const n = v.shares.length + v.iOwe.length + v.theyOwe.length;
  return `
    <div class="card debt ${cls}">
      <div class="row" style="border:0;padding:0">
        <span class="avatar big">${esc(initials(nameOf(v.other)))}</span>
        <div class="grow">
          <div class="small muted">${head}</div>
          <div class="strong" style="font-size:18px">${esc(nameOf(v.other))}</div>
        </div>
        ${v.money ? `<div class="big-amount ${v.money > 0 ? "danger" : "ok"}">${fmt(Math.abs(v.money))}</div>` : ""}
      </div>
      ${v.money > 0 ? pixLine(v.other) : ""}
      ${itemsLine}
      <details class="items" data-pair="${key}" ${state.openPairs.has(key) ? "open" : ""}>
        <summary>Detalhes (${n})</summary>
        ${v.shares.map(shareRow).join("")}
        ${v.iOwe.map((it) => itemRow(it, state.mid, v.other)).join("")}
        ${v.theyOwe.map((it) => itemRow(it, v.other, state.mid)).join("")}
      </details>
      ${v.money !== 0 ? `
      <div class="actions" style="margin-top:10px">
        <button class="btn btn-primary btn-block" data-action="settle-pair" data-a="${p.a}" data-b="${p.b}">${v.money > 0 ? "Paguei tudo" : "Recebi tudo"} · ${fmt(Math.abs(v.money))}</button>
      </div>` : ""}
    </div>`;
}

/** Linha de cota de conta (signed > 0 no sentido eu→outro). */
function shareRow(s) {
  const neg = s.signed < 0;
  const meId = actorId();
  const mine = s.from === meId || s.to === meId;
  const who = resolveCtx(s.ctx)?.who || nameOf;
  const note = neg ? `abate: ${esc(who(s.from))} deve isso pra ${esc(who(s.to))}` : `${esc(who(s.from))} paga pra ${esc(who(s.to))}`;
  return `
    <div class="row item ${neg ? "neg" : ""}">
      <div class="grow"><div>${s.label}</div><div class="sub">${note}</div></div>
      <span class="amt">${neg ? "−" : ""}${fmt(s.amount)}</span>
      ${mine ? `
        <div class="item-actions">
          <button class="btn btn-sm" data-action="toggle-share" data-ctx="${s.ctx}" data-mid="${s.from}">${s.from === meId ? "Paguei" : "Recebi"}</button>
          ${s.from === meId ? `<button class="btn btn-sm btn-ghost" data-action="attach-share" data-ctx="${s.ctx}" data-mid="${s.from}" title="Anexar comprovante">📎</button>` : ""}
        </div>` : ""}
    </div>`;
}

/** Linha de item devido: `debtor` deve qty× item ao `creditor`. */
function itemRow(it, debtor, creditor) {
  const mine = debtor === state.mid || creditor === state.mid;
  return `
    <div class="row item">
      <div class="grow"><div>🍺 ${esc(it.label)}</div><div class="sub">${esc(nameOf(debtor))} deve pra ${esc(nameOf(creditor))}</div></div>
      <span class="amt">${it.qty}×</span>
      ${mine ? `<div class="item-actions"><button class="btn btn-sm" data-action="return-items" data-debtor="${debtor}" data-creditor="${creditor}" data-item="${esc(it.label)}" data-qty="${it.qty}">${debtor === state.mid ? "Devolvi" : "Devolveu"}</button></div>` : ""}
    </div>`;
}

function otherPairRow(p) {
  const v = pairView(p, p.a); // relativo a `a`
  const key = `${p.a}|${p.b}`;
  const debtor = v.money >= 0 ? p.a : p.b, creditor = v.money >= 0 ? p.b : p.a;
  const bits = [];
  if (v.money) bits.push(`${esc(nameOf(debtor))} deve <b>${fmt(Math.abs(v.money))}</b> pra ${esc(nameOf(creditor))}`);
  if (v.iOwe.length) bits.push(`${esc(nameOf(p.a))} deve <b>${fmtItems(v.iOwe)}</b> pra ${esc(nameOf(p.b))}`);
  if (v.theyOwe.length) bits.push(`${esc(nameOf(p.b))} deve <b>${fmtItems(v.theyOwe)}</b> pra ${esc(nameOf(p.a))}`);
  return `
    <details class="items sub-items" data-pair="${key}" ${state.openPairs.has(key) ? "open" : ""}>
      <summary class="row" style="padding:10px 0"><div class="grow">${bits.join("<br>")}</div><span class="muted">▸</span></summary>
      ${v.shares.map(shareRow).join("")}
      ${v.iOwe.map((it) => itemRow(it, p.a, p.b)).join("")}
      ${v.theyOwe.map((it) => itemRow(it, p.b, p.a)).join("")}
    </details>`;
}

function monthCard() {
  const cm = currentMonth();
  const monthBills = state.bills.filter((b) => b.month === cm);
  const monthTotal = monthBills.reduce((a, b) => a + b.amount, 0);
  const myMonth = monthBills.reduce((a, b) => a + (b.shares?.[state.mid]?.amount || 0), 0);
  const monthShares = monthBills.flatMap((b) => Object.values(b.shares || {}));
  const monthPaid = monthShares.filter((s) => s.paid).length;
  return `
    <div class="card tap" data-action="tab" data-tab="bills">
      <div class="card-title"><h2>${cap(monthLabel(cm, true))}</h2><span class="muted small">ver contas ›</span></div>
      ${monthBills.length ? `
        <div class="row"><div class="grow">Total das contas</div><span class="amt">${fmt(monthTotal)}</span></div>
        <div class="row"><div class="grow">Sua parte</div><span class="amt">${fmt(myMonth)}</span></div>
        <div class="row"><div class="grow">Pagamentos</div><span class="chip ${monthPaid === monthShares.length ? "ok" : ""}">${monthPaid}/${monthShares.length}</span></div>
      ` : `<div class="empty">Nenhuma conta lançada este mês</div>`}
    </div>`;
}

// --- Contas

function renderBills() {
  const bills = state.bills
    .filter((b) => b.month === state.month)
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.createdAt - b.createdAt);
  const total = bills.reduce((a, b) => a + b.amount, 0);
  return `
    <div class="monthnav">
      <button class="btn" data-action="month" data-delta="-1" aria-label="Mês anterior">‹</button>
      <span class="label">${cap(monthLabel(state.month, true))}</span>
      <button class="btn" data-action="month" data-delta="1" aria-label="Próximo mês">›</button>
    </div>
    ${bills.length ? `
      <div class="share-row" style="justify-content:space-between">
        <button class="btn btn-sm" data-action="share-month">📤 Resumo do mês</button>
        <span class="muted small">Total do mês: <b>${fmt(total)}</b></span>
      </div>` : ""}
    ${bills.length ? bills.map(billCard).join("") : `
      <div class="card"><div class="empty"><div class="big">🧾</div>Nenhuma conta em ${monthLabel(state.month, true)}.<br><span class="small">Toque em “Nova conta” pra lançar.</span></div></div>`}
    <button class="fab" data-action="bill-new"><span class="plus">+</span> Nova conta</button>`;
}

function billCard(b) {
  const shares = Object.entries(b.shares || {});
  const paidCount = shares.filter(([, s]) => s.paid).length;
  const mine = b.shares?.[state.mid];
  let status;
  if (b.paidBy === state.mid) status = `<span class="chip warn">Você pagou a conta</span>`;
  else if (!mine) status = `<span class="chip">Você não participa</span>`;
  else if (mine.paid) status = `<span class="chip ok">Sua parte: ${fmt(mine.amount)} · paga</span>`;
  else status = `<span class="chip danger">Sua parte: ${fmt(mine.amount)} · pendente</span>`;
  return `
    <div class="card tap" data-action="bill-open" data-id="${b.id}">
      <div class="row" style="border:0;padding:0">
        <span class="ico">${CATEGORIES[b.category]?.icon || "🧾"}</span>
        <div class="grow">
          <div class="strong ellipsis">${esc(b.title)}</div>
          <div class="sub">pago por ${esc(nameOf(b.paidBy))} · ${paidCount}/${shares.length} pagaram</div>
        </div>
        <span class="amt">${fmt(b.amount)}</span>
      </div>
      <div class="bar"><i style="width:${shares.length ? Math.round((paidCount / shares.length) * 100) : 0}%"></i></div>
      <div class="mt">${status}</div>
    </div>`;
}

function billDetailHtml(b) {
  const rows = (b.splitAmong || []).map((mid) => {
    const s = b.shares?.[mid];
    if (!s) return "";
    const isPayer = mid === b.paidBy;
    let sub;
    if (isPayer) sub = "pagou a conta";
    else if (s.paid) {
      sub = `pago ${dateLabel(s.paidAt)}${s.markedBy ? " · por " + esc(nameOf(s.markedBy)) : ""}`;
      sub += s.receiptId
        ? ` · <button class="link small" data-action="view-receipt" data-id="${s.receiptId}" data-ctx="bill:${b.id}">🧾 ver comprovante</button>`
        : ` · <button class="link small" data-action="attach-share" data-ctx="bill:${b.id}" data-mid="${mid}">📎 anexar comprovante</button>`;
    } else {
      sub = `pendente · <button class="link small" data-action="attach-share" data-ctx="bill:${b.id}" data-mid="${mid}">📎 paguei, anexar comprovante</button>`;
    }
    return `
      <div class="row">
        <span class="avatar">${esc(initials(nameOf(mid)))}</span>
        <div class="grow">
          <div>${esc(nameOf(mid))}${mid === state.mid ? ' <span class="muted small">(você)</span>' : ""}</div>
          <div class="sub">${sub}</div>
        </div>
        <span class="amt">${fmt(s.amount)}</span>
        <label class="switch"><input type="checkbox" data-action="toggle-share" data-ctx="bill:${b.id}" data-mid="${mid}" ${s.paid ? "checked" : ""} ${isPayer ? "disabled" : ""}><i></i></label>
      </div>`;
  }).join("");
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${CATEGORIES[b.category]?.icon || "🧾"} ${esc(b.title)}</h2>
      <p class="muted">${monthLabel(b.month, true)} · pago por <b>${esc(nameOf(b.paidBy))}</b></p>
      <div class="big-amount">${fmt(b.amount)}</div>
      ${b.paidBy !== state.mid ? pixLine(b.paidBy) : ""}
      ${b.notes ? `<p class="muted small mt">${esc(b.notes)}</p>` : ""}
      <h3 class="mt">Quem já pagou sua parte</h3>
      ${rows}
      <div class="actions">
        <button class="btn btn-block" data-action="bill-duplicate" data-id="${b.id}">🔁 Repetir em ${cap(monthLabel(addMonths(b.month, 1), true))}</button>
      </div>
      <div class="actions" style="margin-top:10px">
        <button class="btn" data-action="bill-edit" data-id="${b.id}">Editar</button>
        <button class="btn btn-danger-ghost" data-action="bill-delete" data-id="${b.id}">Excluir</button>
      </div>
    </div>`;
}

function billFormHtml(b) {
  const isEdit = !!b?.id;
  const cat = b?.category || "aluguel";
  const month = b?.month || state.month;
  const treasurer = state.group?.treasurer;
  const paidBy = b?.paidBy || (treasurer && memberById(treasurer)?.active !== false ? treasurer : state.mid);
  const split = new Set(b?.splitAmong || activeMembers().map((m) => m.id));
  const monthOptions = new Set([month]);
  for (let i = -6; i <= 6; i++) monthOptions.add(addMonths(currentMonth(), i));
  const months = [...monthOptions].sort();
  // membros ativos + quem já está na conta
  const pool = state.members.filter((m) => m.active !== false || split.has(m.id) || m.id === paidBy);
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${isEdit ? "Editar conta" : "Nova conta"}</h2>
      <form data-form="bill" data-id="${b?.id || ""}">
        <div class="seg">
          ${CATEGORY_ORDER.map((c) => `<label><input type="radio" name="category" value="${c}" ${c === cat ? "checked" : ""}><span>${CATEGORIES[c].icon} ${CATEGORIES[c].label}</span></label>`).join("")}
        </div>
        <label class="field"><span>Descrição</span>
          <input type="text" name="title" required maxlength="60" value="${esc(b?.title || CATEGORIES[cat].label)}" placeholder="Ex.: Faxina, gás, churrasqueira" autocomplete="off">
        </label>
        <label class="field"><span>Mês</span>
          <select name="month">${months.map((m) => `<option value="${m}" ${m === month ? "selected" : ""}>${monthLabel(m, true)}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Valor total</span>
          <input type="text" class="money" name="amount" inputmode="numeric" data-cents="${b?.amount || 0}" value="${fmt(b?.amount || 0)}" autocomplete="off">
        </label>
        <label class="field"><span>Quem pagou a conta (recebe dos outros)</span>
          <select name="paidBy">${pool.map((m) => `<option value="${m.id}" ${m.id === paidBy ? "selected" : ""}>${esc(m.name)}${m.id === treasurer ? " 💰" : ""}</option>`).join("")}</select>
        </label>
        <div class="field-label">Dividir entre <button type="button" class="link" data-action="check-all" style="margin-left:8px">todos / ninguém</button></div>
        <div class="checks">
          ${pool.map((m) => `<label><input type="checkbox" name="split" value="${m.id}" ${split.has(m.id) ? "checked" : ""}> ${esc(m.name)}${m.active === false ? ' <span class="muted small">(inativo)</span>' : ""}</label>`).join("")}
        </div>
        <label class="field"><span>Observação (opcional)</span>
          <input type="text" name="notes" maxlength="120" value="${esc(b?.notes || "")}" autocomplete="off">
        </label>
        <div class="error" data-error hidden></div>
        <button class="btn btn-primary btn-block" type="submit">${isEdit ? "Salvar" : "Lançar conta"}</button>
      </form>
    </div>`;
}

// --- Geladeira

function renderFridge() {
  const mine = itemBalancesFor(state.mid);
  const others = [...itemBalances()].filter(([key]) => !key.split("|").includes(state.mid));
  return `
    <div class="card">
      <h2>Seus saldos</h2>
      ${mine.length ? mine.map(fridgeBalanceCard).join("") : `<div class="empty"><div class="big">🍻</div>Você não deve nada e ninguém te deve.</div>`}
    </div>
    ${others.length ? `
    <div class="card">
      <details data-pair="__fridge_others" ${state.openPairs.has("__fridge_others") ? "open" : ""}>
        <summary>Entre os outros (${others.length})</summary>
        ${others.map(([key, items]) => {
          const [a, b] = key.split("|");
          const aOwes = [...items.values()].filter((i) => i.net > 0).map((i) => ({ label: i.label, qty: i.net }));
          const bOwes = [...items.values()].filter((i) => i.net < 0).map((i) => ({ label: i.label, qty: -i.net }));
          return `<div class="row"><div class="grow">
            ${aOwes.length ? `${esc(nameOf(a))} deve <b>${fmtItems(aOwes)}</b> pra ${esc(nameOf(b))}` : ""}${aOwes.length && bOwes.length ? "<br>" : ""}${bOwes.length ? `${esc(nameOf(b))} deve <b>${fmtItems(bOwes)}</b> pra ${esc(nameOf(a))}` : ""}
          </div></div>`;
        }).join("")}
      </details>
    </div>` : ""}
    <div class="card">
      <h2>Lançamentos</h2>
      ${state.fridge.length ? state.fridge.map(fridgeRow).join("") : `<div class="empty">Nenhum lançamento ainda.<br><span class="small">Pegou uma cerveja de alguém? Lança aqui.</span></div>`}
    </div>
    <button class="fab" data-action="fridge-new"><span class="plus">+</span> Lançar</button>`;
}

function fridgeBalanceCard({ other, iOwe, theyOwe }) {
  const line = (it, debtor, creditor) => `
    <div class="row item">
      <div class="grow">${debtor === state.mid ? "Você deve" : `${esc(nameOf(debtor))} te deve`} <b>${it.qty}× ${esc(it.label)}</b></div>
      <button class="btn btn-sm" data-action="return-items" data-debtor="${debtor}" data-creditor="${creditor}" data-item="${esc(it.label)}" data-qty="${it.qty}">${debtor === state.mid ? "Devolvi" : "Devolveu"}</button>
    </div>`;
  return `
    <div class="row" style="flex-wrap:wrap;align-items:flex-start">
      <span class="avatar">${esc(initials(nameOf(other)))}</span>
      <div class="grow">
        <div class="strong">${esc(nameOf(other))}</div>
        ${iOwe.map((it) => line(it, state.mid, other)).join("")}
        ${theyOwe.map((it) => line(it, other, state.mid)).join("")}
      </div>
    </div>`;
}

function fridgeRow(e) {
  const text = e.kind === "pegou"
    ? `<b>${esc(nameOf(e.to))}</b> pegou <b>${e.qty}× ${esc(e.item)}</b> de <b>${esc(nameOf(e.from))}</b>`
    : `<b>${esc(nameOf(e.from))}</b> devolveu <b>${e.qty}× ${esc(e.item)}</b> pra <b>${esc(nameOf(e.to))}</b>`;
  return `
    <div class="row">
      <span class="ico">${e.kind === "pegou" ? "🍺" : "↩️"}</span>
      <div class="grow">
        <div>${text}</div>
        <div class="sub">${dateLabel(e.createdAt)}${e.note ? " · " + esc(e.note) : ""}</div>
      </div>
      <button class="btn btn-sm btn-ghost" data-action="fridge-delete" data-id="${e.id}" aria-label="Excluir">🗑</button>
    </div>`;
}

function fridgeFormHtml(preset = {}) {
  const kind = preset.kind || "pegou";
  const pool = state.members.filter((m) => m.active !== false || m.id === preset.other);
  const others = pool.filter((m) => m.id !== state.mid);
  const other = preset.other || others[0]?.id || "";
  const opts = (sel) => pool.map((m) => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.name)}${m.id === state.mid ? " (você)" : ""}</option>`).join("");
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>Lançar na geladeira</h2>
      <form data-form="fridge">
        <div class="seg">
          <label><input type="radio" name="kind" value="pegou" ${kind === "pegou" ? "checked" : ""}><span>🍺 Pegou</span></label>
          <label><input type="radio" name="kind" value="devolveu" ${kind === "devolveu" ? "checked" : ""}><span>↩️ Devolveu</span></label>
        </div>
        <label class="field"><span data-label-a>${kind === "pegou" ? "Quem pegou" : "Quem devolveu"}</span>
          <select name="a">${opts(preset.a || state.mid)}</select>
        </label>
        <label class="field"><span data-label-b>${kind === "pegou" ? "De quem" : "Pra quem"}</span>
          <select name="b">${opts(other)}</select>
        </label>
        <label class="field"><span>O quê</span>
          <input type="text" name="item" required maxlength="40" placeholder="Ex.: Heineken" value="${esc(preset.item || "")}" autocomplete="off">
        </label>
        <div class="field">
          <span class="field-label">Quantidade</span>
          <div class="stepper">
            <button type="button" data-action="step" data-delta="-1" aria-label="Menos">−</button>
            <input type="text" name="qty" inputmode="numeric" pattern="[0-9]*" value="${preset.qty || 1}" aria-label="Quantidade">
            <button type="button" data-action="step" data-delta="1" aria-label="Mais">+</button>
          </div>
        </div>
        <label class="field"><span>Observação (opcional)</span>
          <input type="text" name="note" maxlength="80" placeholder="Ex.: da gaveta de baixo" autocomplete="off">
        </label>
        <div class="error" data-error hidden></div>
        <button class="btn btn-primary btn-block" type="submit">Lançar</button>
      </form>
    </div>`;
}

function settleFormHtml(p, eid = "") {
  const ev = eid ? state.events.get(eid)?.doc : null;
  const v = pairView(p, actorId());
  const who = (id) => (ev ? pName(ev, id) : nameOf(id));
  const iOwe = v.money > 0;
  const n = v.shares.length;
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>Acertar contas com ${esc(who(v.other))}</h2>
      <p>${iOwe ? `Você paga <b>${fmt(v.money)}</b> pra ${esc(who(v.other))}.` : `${esc(who(v.other))} te paga <b>${fmt(-v.money)}</b>.`}</p>
      ${iOwe ? pixLine(v.other, ev) : ""}
      <p class="small muted mt">Isso marca como pagas ${n} parte${n === 1 ? "" : "s"}${ev ? " deste evento" : " de conta (contas do espaço e eventos)"}.${ev ? "" : " Itens da geladeira não entram — use “Devolvi”."}</p>
      <form data-form="settle" data-a="${p.a}" data-b="${p.b}" data-eid="${eid}">
        <div class="field">
          <button type="button" class="btn btn-block" data-action="pick-receipt">📎 Anexar comprovante (opcional)</button>
          <div class="small muted mt" data-receipt-status></div>
        </div>
        <button class="btn btn-primary btn-block" type="submit">${iOwe ? "Confirmar: paguei tudo" : "Confirmar: recebi tudo"}</button>
      </form>
    </div>`;
}

// --- Eventos (churrasco etc.): integrantes + convidados, rateio próprio

function renderEvents() {
  if (state.openEvent) {
    const entry = state.events.get(state.openEvent);
    if (!entry || entry.doc === undefined) return `<div class="center muted">Carregando evento…</div>`;
    if (entry.missing || !entry.doc) {
      return `<div class="card"><div class="empty"><div class="big">🤔</div>Evento não encontrado.</div><button class="btn btn-block" data-action="event-back">‹ Voltar</button></div>`;
    }
    syncMyParticipant(entry);
    return eventDetailHtml(entry, { guest: false });
  }
  const list = groupEvents();
  return `
    <p class="muted small">Churrasco, festa, viagem: despesas rateadas entre integrantes e convidados. Convidados só enxergam o evento.</p>
    ${list.length ? list.map(eventCard).join("") : `<div class="card"><div class="empty"><div class="big">🍖</div>Nenhum evento ainda.<br><span class="small">Toque em “Novo evento” pra criar.</span></div></div>`}
    <button class="fab" data-action="event-new"><span class="plus">+</span> Novo evento</button>`;
}

function eventCard(entry) {
  const ev = entry.doc;
  const total = entry.expenses.reduce((a, x) => a + x.amount, 0);
  const n = evParts(ev).length;
  const mine = eventPairs(entry).filter((p) => p.a === state.mid || p.b === state.mid).map((p) => pairView(p, state.mid));
  const owe = mine.reduce((a, v) => a + Math.max(0, v.money), 0);
  const owed = mine.reduce((a, v) => a + Math.max(0, -v.money), 0);
  const inEvent = !!ev.participants?.[state.mid];
  let status = "";
  if (!inEvent) status = `<span class="chip">Você não participa</span>`;
  else if (owe) status = `<span class="chip danger">Você deve ${fmt(owe)}</span>`;
  else if (owed) status = `<span class="chip ok">Te devem ${fmt(owed)}</span>`;
  else status = `<span class="chip ok">Tudo certo</span>`;
  return `
    <div class="card tap" data-action="event-open" data-id="${entry.id}">
      <div class="row" style="border:0;padding:0">
        <span class="ico">🍖</span>
        <div class="grow">
          <div class="strong ellipsis">${esc(ev.name)}</div>
          <div class="sub">${dateBR(ev.date)} · ${n} pessoa${n === 1 ? "" : "s"} · ${entry.expenses.length} despesa${entry.expenses.length === 1 ? "" : "s"}</div>
        </div>
        <span class="amt">${fmt(total)}</span>
      </div>
      <div class="mt">${status}</div>
    </div>`;
}

function eventDetailHtml(entry, { guest }) {
  const ev = entry.doc;
  const meId = actorId();
  const parts = evParts(ev);
  const total = entry.expenses.reduce((a, x) => a + x.amount, 0);
  const canManage = !guest && (amAdmin() || ev.createdBy === state.mid);
  const pairs = eventPairs(entry);
  const hasShares = (pid) => entry.expenses.some((x) => x.shares?.[pid] || x.paidBy === pid);
  return `
    ${guest ? "" : `<button class="link" data-action="event-back">‹ Eventos</button>`}
    <div class="card event-head">
      <div class="row" style="border:0;padding:0">
        <span class="ico">🍖</span>
        <div class="grow">
          <h2 style="margin:0">${esc(ev.name)}</h2>
          <div class="sub">${dateBR(ev.date)} · ${parts.length} pessoa${parts.length === 1 ? "" : "s"}</div>
        </div>
        <span class="amt">${fmt(total)}</span>
      </div>
      <div class="share-row" style="margin:12px 0 0;flex-wrap:wrap">
        ${guest ? "" : `<button class="btn btn-sm" data-action="event-link" data-id="${entry.id}">🔗 Link pros convidados</button>`}
        <button class="btn btn-sm" data-action="share-event" data-id="${entry.id}">📤 Resumo</button>
        ${guest ? "" : `<button class="btn btn-sm" data-action="event-edit" data-id="${entry.id}">✏️</button>`}
        ${canManage ? `<button class="btn btn-sm btn-danger-ghost" data-action="event-delete" data-id="${entry.id}">🗑</button>` : ""}
      </div>
    </div>

    <div class="card">
      <div class="card-title"><h2>Participantes</h2></div>
      <div class="participants">
        ${parts.map((p) => `
          <span class="pchip ${p.pid === meId ? "me" : ""}">
            <span class="avatar">${esc(initials(p.name))}</span>${esc(pName(ev, p.pid))}${p.member ? "" : ' <span class="muted small">convidado</span>'}
            ${!guest && !p.member && !hasShares(p.pid) ? `<button class="x" data-action="participant-remove" data-eid="${entry.id}" data-id="${p.pid}" aria-label="Remover">✕</button>` : ""}
          </span>`).join("")}
      </div>
      ${guest ? "" : `
      <div class="actions" style="margin-top:12px">
        <button class="btn btn-sm" data-action="participant-add-members" data-id="${entry.id}">+ Integrante</button>
        <button class="btn btn-sm" data-action="participant-add-guest" data-id="${entry.id}">+ Convidado</button>
      </div>`}
    </div>

    <div class="card">
      <div class="card-title"><h2>Despesas</h2><button class="btn btn-sm btn-primary" data-action="expense-new" data-id="${entry.id}">+ Despesa</button></div>
      ${entry.expenses.length ? entry.expenses.map((x) => expenseRow(entry, x)).join("") : `<div class="empty">Nenhuma despesa lançada.<br><span class="small">Comprou a carne, o gelo, a bebida? Lança aqui.</span></div>`}
    </div>

    <div class="card">
      <h2>Quem deve pra quem</h2>
      ${pairs.length ? pairs.map((p) => eventPairRow(entry, p)).join("") : `<div class="empty">Ninguém deve nada neste evento 🍻</div>`}
    </div>`;
}

function expenseRow(entry, x) {
  const ev = entry.doc;
  const shares = Object.entries(x.shares || {});
  const paid = shares.filter(([, s]) => s.paid).length;
  const meId = actorId();
  const mine = x.shares?.[meId];
  let chip = "";
  if (x.paidBy === meId) chip = `<span class="chip warn">Você pagou</span>`;
  else if (!mine) chip = `<span class="chip">Você não entra</span>`;
  else chip = mine.paid ? `<span class="chip ok">Sua parte: ${fmt(mine.amount)} · paga</span>` : `<span class="chip danger">Sua parte: ${fmt(mine.amount)} · pendente</span>`;
  return `
    <div class="row tap" data-action="expense-open" data-ctx="ev:${entry.id}:${x.id}">
      <div class="grow">
        <div class="strong ellipsis">${esc(x.title)}</div>
        <div class="sub">pagou ${esc(pName(ev, x.paidBy))} · ${paid}/${shares.length} pagaram</div>
        <div style="margin-top:4px">${chip}</div>
      </div>
      <span class="amt">${fmt(x.amount)}</span>
      <span class="muted">›</span>
    </div>`;
}

function eventPairRow(entry, p) {
  const ev = entry.doc;
  const meId = actorId();
  const debtor = p.moneyNet > 0 ? p.a : p.b, creditor = p.moneyNet > 0 ? p.b : p.a;
  const involved = debtor === meId || creditor === meId;
  return `
    <div class="row" style="flex-wrap:wrap">
      <span class="avatar">${esc(initials(pName(ev, debtor)))}</span>
      <div class="grow">${debtor === meId ? "<b>Você</b> deve" : `<b>${esc(pName(ev, debtor))}</b> deve`} <b class="${debtor === meId ? "danger" : creditor === meId ? "ok" : ""}">${fmt(Math.abs(p.moneyNet))}</b> pra ${creditor === meId ? "<b>você</b>" : `<b>${esc(pName(ev, creditor))}</b>`}</div>
      ${involved ? `<button class="btn btn-sm" data-action="settle-pair" data-eid="${entry.id}" data-a="${p.a}" data-b="${p.b}">${debtor === meId ? "Paguei tudo" : "Recebi tudo"}</button>` : ""}
      ${debtor === meId ? `<div style="flex-basis:100%">${pixLine(creditor, ev)}</div>` : ""}
    </div>`;
}

function expenseDetailHtml(entry, x) {
  const ev = entry.doc;
  const ctx = `ev:${entry.id}:${x.id}`;
  const meId = actorId();
  const rows = (x.splitAmong || []).map((pid) => {
    const sh = x.shares?.[pid];
    if (!sh) return "";
    const isPayer = pid === x.paidBy;
    let sub;
    if (isPayer) sub = "pagou a despesa";
    else if (sh.paid) {
      sub = `pago ${dateLabel(sh.paidAt)}${sh.markedBy ? " · por " + esc(pName(ev, sh.markedBy)) : ""}`;
      sub += sh.receiptId
        ? ` · <button class="link small" data-action="view-receipt" data-id="${sh.receiptId}" data-ctx="${ctx}">🧾 ver comprovante</button>`
        : ` · <button class="link small" data-action="attach-share" data-ctx="${ctx}" data-mid="${pid}">📎 anexar comprovante</button>`;
    } else {
      sub = `pendente · <button class="link small" data-action="attach-share" data-ctx="${ctx}" data-mid="${pid}">📎 paguei, anexar comprovante</button>`;
    }
    return `
      <div class="row">
        <span class="avatar">${esc(initials(pName(ev, pid)))}</span>
        <div class="grow">
          <div>${esc(pName(ev, pid))}${pid === meId ? ' <span class="muted small">(você)</span>' : ""}</div>
          <div class="sub">${sub}</div>
        </div>
        <span class="amt">${fmt(sh.amount)}</span>
        <label class="switch"><input type="checkbox" data-action="toggle-share" data-ctx="${ctx}" data-mid="${pid}" ${sh.paid ? "checked" : ""} ${isPayer ? "disabled" : ""}><i></i></label>
      </div>`;
  }).join("");
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>🍖 ${esc(x.title)}</h2>
      <p class="muted">${esc(ev.name)} · pagou <b>${esc(pName(ev, x.paidBy))}</b></p>
      <div class="big-amount">${fmt(x.amount)}</div>
      ${x.paidBy !== meId ? pixLine(x.paidBy, ev) : ""}
      ${x.notes ? `<p class="muted small mt">${esc(x.notes)}</p>` : ""}
      <h3 class="mt">Quem já pagou sua parte</h3>
      ${rows}
      <div class="actions">
        <button class="btn" data-action="expense-edit" data-ctx="${ctx}">Editar</button>
        <button class="btn btn-danger-ghost" data-action="expense-delete" data-ctx="${ctx}">Excluir</button>
      </div>
    </div>`;
}

function eventFormHtml(entry = null) {
  const ev = entry?.doc;
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${ev ? "Editar evento" : "Novo evento"}</h2>
      <form data-form="event" data-id="${entry?.id || ""}">
        <label class="field"><span>Nome</span>
          <input type="text" name="name" required maxlength="40" value="${esc(ev?.name || "")}" placeholder="Ex.: Churrasco de sábado" autocomplete="off">
        </label>
        <label class="field"><span>Data</span>
          <input type="date" name="date" required value="${esc(ev?.date || ymd)}">
        </label>
        ${ev ? "" : `<p class="help">Você já entra como participante. Depois adicione os integrantes e os convidados, e mande o link pros convidados.</p>`}
        <button class="btn btn-primary btn-block" type="submit">${ev ? "Salvar" : "Criar evento"}</button>
      </form>
    </div>`;
}

function participantsFormHtml(entry) {
  const ev = entry.doc;
  const candidates = activeMembers().filter((m) => !ev.participants?.[m.id]);
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>Adicionar integrantes</h2>
      <form data-form="participants" data-id="${entry.id}">
        ${candidates.length ? `
        <div class="checks">
          ${candidates.map((m) => `<label><input type="checkbox" name="mid" value="${m.id}" checked> ${esc(m.name)}</label>`).join("")}
        </div>
        <button class="btn btn-primary btn-block" type="submit">Adicionar</button>` : `<p class="muted">Todos os integrantes ativos já estão no evento.</p>`}
      </form>
    </div>`;
}

function guestFormHtml(entry) {
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>Adicionar convidado</h2>
      <form data-form="guest" data-id="${entry.id}">
        <label class="field"><span>Nome</span>
          <input type="text" name="name" required maxlength="30" placeholder="Como a pessoa é conhecida" autocomplete="off">
        </label>
        <label class="field"><span>Chave Pix (opcional)</span>
          <input type="text" name="pix" maxlength="80" placeholder="Se ela for pagar algo pro grupo" autocomplete="off">
        </label>
        <p class="help">Depois mande o link do evento pra pessoa: ela escolhe o próprio nome e vê só este evento.</p>
        <div class="error" data-error hidden></div>
        <button class="btn btn-primary btn-block" type="submit">Adicionar</button>
      </form>
    </div>`;
}

function expenseFormHtml(entry, x = null) {
  const ev = entry.doc;
  const meId = actorId();
  const parts = evParts(ev);
  const paidBy = x?.paidBy || (ev.participants?.[meId] ? meId : parts[0]?.pid);
  const split = new Set(x?.splitAmong || parts.map((p) => p.pid));
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${x ? "Editar despesa" : "Nova despesa"}</h2>
      <form data-form="expense" data-eid="${entry.id}" data-id="${x?.id || ""}">
        <label class="field"><span>O quê</span>
          <input type="text" name="title" required maxlength="60" value="${esc(x?.title || "")}" placeholder="Ex.: Picanha, gelo, carvão" autocomplete="off">
        </label>
        <label class="field"><span>Valor total</span>
          <input type="text" class="money" name="amount" inputmode="numeric" data-cents="${x?.amount || 0}" value="${fmt(x?.amount || 0)}" autocomplete="off">
        </label>
        <label class="field"><span>Quem pagou (recebe dos outros)</span>
          <select name="paidBy">${parts.map((p) => `<option value="${p.pid}" ${p.pid === paidBy ? "selected" : ""}>${esc(pName(ev, p.pid))}${p.pid === meId ? " (você)" : ""}</option>`).join("")}</select>
        </label>
        <div class="field-label">Dividir entre <button type="button" class="link" data-action="check-all" style="margin-left:8px">todos / ninguém</button></div>
        <div class="checks">
          ${parts.map((p) => `<label><input type="checkbox" name="split" value="${p.pid}" ${split.has(p.pid) ? "checked" : ""}> ${esc(pName(ev, p.pid))}</label>`).join("")}
        </div>
        <label class="field"><span>Observação (opcional)</span>
          <input type="text" name="notes" maxlength="120" value="${esc(x?.notes || "")}" autocomplete="off">
        </label>
        <div class="error" data-error hidden></div>
        <button class="btn btn-primary btn-block" type="submit">${x ? "Salvar" : "Lançar despesa"}</button>
      </form>
    </div>`;
}

// --- Galera

function renderPeople() {
  const link = inviteLink();
  return `
    <div class="card">
      <div class="card-title"><h2>Integrantes</h2>${amAdmin() ? `<button class="btn btn-sm" data-action="member-new">+ Adicionar</button>` : ""}</div>
      ${state.members.map((m) => `
        <div class="row tap" data-action="member-open" data-id="${m.id}">
          <span class="avatar">${esc(initials(m.name))}</span>
          <div class="grow">
            <div>${esc(m.name)}${m.id === state.mid ? ' <span class="muted small">(você)</span>' : ""}${isAdmin(m.id) ? ' <span class="chip">🛡️ admin</span>' : ""}${state.group?.treasurer === m.id ? ' <span class="chip warn">💰 responsável</span>' : ""}</div>
            <div class="sub ellipsis">${m.active === false ? "inativo" : "ativo"} · ${m.pix ? `Pix: ${esc(m.pix)}` : "sem Pix"}</div>
          </div>
          <span class="muted">›</span>
        </div>`).join("")}
      <p class="small muted mt mb0">Toque num integrante pra ver Pix, PIN e ajustes.</p>
    </div>

    <div class="card">
      <h2>Convidar pro grupo</h2>
      <p class="muted small">Quem abrir este link entra no grupo e se cadastra com nome e PIN.</p>
      <div class="linkbox">${esc(link)}</div>
      <div class="actions" style="margin-top:0">
        <button class="btn" data-action="copy-link">Copiar link</button>
        ${navigator.share ? `<button class="btn btn-primary" data-action="share-link">Compartilhar</button>` : ""}
      </div>
    </div>

    <div class="card">
      <h2>Grupo</h2>
      <div class="row"><div class="grow">${esc(state.group.name)}</div>${amAdmin() ? `<button class="btn btn-sm" data-action="group-rename">Renomear</button>` : ""}</div>
      <div class="row"><div class="grow"><div>🛡️ Administração</div><div class="sub">${state.members.filter((m) => isAdmin(m.id)).map((a) => esc(a.name)).join(", ") || "—"}${amAdmin() ? " · você administra o grupo" : ""}</div></div></div>
      <div class="row">
        <div class="grow">
          <div>💰 Responsável pelas contas</div>
          <div class="sub">${state.group.treasurer && memberById(state.group.treasurer) ? `${esc(nameOf(state.group.treasurer))} recebe aluguel, água e luz` : amAdmin() ? "Ninguém definido — toque num integrante pra definir" : "Ninguém definido — peça ao administrador"}</div>
        </div>
      </div>
      <div class="row"><div class="grow">Sair da sua conta neste aparelho</div><button class="btn btn-sm" data-action="logout">Sair</button></div>
    </div>`;
}

function memberSheetHtml(m) {
  const isMe = m.id === state.mid;
  const isTreasurer = state.group?.treasurer === m.id;
  const admin = amAdmin();
  const tags = [isAdmin(m.id) ? "🛡️ administrador" : "", isTreasurer ? "💰 responsável pelas contas" : "", m.active === false ? "inativo" : "ativo"].filter(Boolean).join(" · ");
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <div class="row" style="border:0;padding:0 0 12px">
        <span class="avatar big">${esc(initials(m.name))}</span>
        <div class="grow">
          <h2 style="margin:0">${esc(m.name)}${isMe ? ' <span class="muted small">(você)</span>' : ""}</h2>
          <div class="small muted">${tags}</div>
        </div>
      </div>
      ${pixLine(m.id)}
      <div class="btn-list mt">
        ${isMe ? `<button class="btn" data-action="member-pix">💠 ${m.pix ? "Editar minha chave Pix" : "Cadastrar minha chave Pix"}</button>` : ""}
        ${isMe ? `<button class="btn" data-action="member-pin" data-id="${m.id}">🔑 Trocar meu PIN</button>` : ""}
        ${!isMe && admin ? `<button class="btn" data-action="member-pin" data-id="${m.id}">🔑 Redefinir PIN (esqueceu)</button>` : ""}
        ${admin && !isTreasurer && m.active !== false ? `<button class="btn" data-action="set-treasurer" data-id="${m.id}">💰 Tornar responsável pelas contas</button>` : ""}
        ${admin && !isMe ? `<button class="btn" data-action="member-admin" data-id="${m.id}">🛡️ ${isAdmin(m.id) ? "Remover da administração" : "Tornar administrador"}</button>` : ""}
      </div>
      ${admin ? `
      <div class="row mt">
        <div class="grow">Participa das divisões${isMe ? ' <span class="muted small">(só outro admin pode te desativar)</span>' : ""}</div>
        <label class="switch"><input type="checkbox" data-action="member-active" data-id="${m.id}" ${m.active !== false ? "checked" : ""} ${isMe ? "disabled" : ""}><i></i></label>
      </div>
      ${!isMe ? `<div class="actions"><button class="btn btn-danger-ghost btn-block" data-action="member-delete" data-id="${m.id}">Excluir do grupo</button></div>` : ""}` : `
      <p class="small muted mt mb0">Ativar/desativar, redefinir PIN e excluir integrantes: só o administrador.</p>`}
    </div>`;
}

function memberFormHtml({ mode, member }) {
  // mode: "new" | "signup" | "pin" (redefinir de alguém) | "mypin" (trocar o meu) | "pix" (minha chave)
  const titles = { new: "Adicionar integrante", signup: "Me cadastrar", pin: `Redefinir PIN de ${member?.name || ""}`, mypin: "Trocar meu PIN", pix: "Minha chave Pix" };
  if (mode === "pix") {
    return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${esc(titles[mode])}</h2>
      <form data-form="member" data-mode="pix">
        <label class="field"><span>Chave Pix</span>
          <input type="text" name="pix" maxlength="80" value="${esc(member?.pix || "")}" placeholder="CPF, celular, e-mail ou chave aleatória" autocomplete="off">
        </label>
        <p class="help">Quem te dever vai ver essa chave e copiar com um toque. Deixe em branco pra remover.</p>
        <button class="btn btn-primary btn-block" type="submit">Salvar</button>
      </form>
    </div>`;
  }
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${esc(titles[mode])}</h2>
      <form data-form="member" data-mode="${mode}" data-id="${member?.id || ""}">
        ${mode === "new" || mode === "signup" ? `
          <label class="field"><span>Nome</span><input type="text" name="name" required maxlength="30" placeholder="Como a galera te chama" autocomplete="off"></label>
          <label class="field"><span>Chave Pix (opcional)</span><input type="text" name="pix" maxlength="80" placeholder="CPF, celular, e-mail ou chave aleatória" autocomplete="off"></label>` : ""}
        ${mode === "mypin" ? `
          <label class="field"><span>PIN atual</span><input class="pin" type="password" name="current" inputmode="numeric" pattern="[0-9]*" maxlength="4" required autocomplete="off"></label>` : ""}
        <label class="field"><span>${mode === "new" ? "PIN da pessoa (4 números)" : "Novo PIN (4 números)"}</span>
          <input class="pin" type="password" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="4" required autocomplete="new-password"></label>
        <label class="field"><span>Repita o PIN</span>
          <input class="pin" type="password" name="pin2" inputmode="numeric" pattern="[0-9]*" maxlength="4" required autocomplete="new-password"></label>
        ${mode === "new" ? `<p class="help">A pessoa pode trocar o PIN depois na aba Galera.</p>` : ""}
        ${mode === "pin" ? `<p class="help">Use quando alguém esqueceu o PIN. A pessoa pode trocar depois.</p>` : ""}
        <div class="error" data-error hidden></div>
        <button class="btn btn-primary btn-block" type="submit">Salvar</button>
      </form>
    </div>`;
}

// ---------------------------------------------------------------- dialogs

const dlg = () => $("#dlg");
function openDialog(html, { detail = null } = {}) {
  state.openDetail = detail; // só o detalhe da conta é re-renderizado ao vivo
  state.pendingReceipt = null;
  const d = dlg();
  d.innerHTML = html;
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}
function closeDialog() {
  state.openDetail = null;
  state.pendingReceipt = null;
  const d = dlg();
  if (d.open) d.close();
  d.innerHTML = "";
}
function showFormError(form, msg) {
  const el = $("[data-error]", form);
  if (!el) return toast(msg);
  el.textContent = msg;
  el.hidden = false;
}

// ---------------------------------------------------------------- ações

const actions = {
  reload: () => location.reload(),
  tab: (el) => {
    state.tab = el.dataset.tab;
    localStorage.setItem(LS.tab, state.tab);
    window.scrollTo(0, 0);
    render();
  },
  month: (el) => { state.month = addMonths(state.month, Number(el.dataset.delta)); render(); },
  "forget-group": () => { localStorage.removeItem(LS.gid); localStorage.removeItem(LS.session); location.reload(); },
  "login-pick": (el) => { state.loginPick = el.dataset.id; state.loginError = ""; render(); },
  "login-back": () => { state.loginPick = null; state.loginError = ""; render(); },
  signup: () => openDialog(memberFormHtml({ mode: "signup" })),
  logout: () => logout(),
  "dlg-close": () => closeDialog(),
  "confirm-yes": () => settleConfirm(true),
  "confirm-no": () => settleConfirm(false),

  "bill-new": () => openDialog(billFormHtml(null)),
  "bill-open": (el) => {
    const b = state.bills.find((x) => x.id === el.dataset.id);
    if (!b) return;
    openDialog(billDetailHtml(b), { detail: "bill:" + b.id });
  },
  "bill-edit": (el) => {
    const b = state.bills.find((x) => x.id === el.dataset.id);
    if (!b) return;
    openDialog(billFormHtml(b));
  },
  "bill-delete": async (el) => {
    const b = state.bills.find((x) => x.id === el.dataset.id);
    if (!b) return;
    if (!(await confirmDialog(`Excluir “${b.title}” de ${monthLabel(b.month)}? Isso apaga também quem já pagou e os comprovantes.`, "Excluir"))) return;
    closeDialog();
    write(() => deleteBill(b), "Conta excluída");
  },
  "bill-duplicate": async (el) => {
    const b = state.bills.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const next = addMonths(b.month, 1);
    const exists = state.bills.some((x) => x.month === next && x.category === b.category && x.title === b.title);
    if (exists && !(await confirmDialog(`Já existe “${b.title}” em ${monthLabel(next)}. Lançar de novo mesmo assim?`, "Lançar"))) return;
    closeDialog();
    if (write(() => duplicateBill(b), `Lançada em ${monthLabel(next)}`)) { state.month = next; render(); }
  },
  "toggle-share": async (el) => {
    const c = resolveCtx(el.dataset.ctx);
    const share = c?.entry.shares?.[el.dataset.mid];
    if (!c || !share) return;
    if (share.paid && share.receiptId) {
      const ok = await confirmDialog("Desmarcar o pagamento e apagar o comprovante anexado?", "Desmarcar");
      if (!ok) { if ("checked" in el) el.checked = true; return; }
    }
    write(() => toggleShare(c.ctx, el.dataset.mid));
  },
  "attach-share": async (el) => {
    let payload;
    try { payload = await pickAndCompressReceipt(); } catch (e) { return toast(e.message, 4500); }
    if (!payload) return;
    attachReceiptToShare(el.dataset.ctx, el.dataset.mid, payload);
  },
  "view-receipt": (el) => openReceipt(el.dataset.id, el.dataset.ctx),
  "open-pdf": () => {
    const r = state.receiptView;
    if (!r) return;
    const url = URL.createObjectURL(dataUrlToBlob(r.dataUrl));
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  "copy-pix": async (el) => {
    if (!el.dataset.pix) return;
    toast((await copyText(el.dataset.pix)) ? `Pix de ${el.dataset.name} copiado!` : "Não consegui copiar. Copie manualmente.", 3000);
  },
  "settle-pair": (el) => {
    const eid = el.dataset.eid || "";
    const pair = eid ? findEventPair(eid, el.dataset.a, el.dataset.b) : findPair(el.dataset.a, el.dataset.b);
    if (!pair || pair.moneyNet === 0) return toast("Nada pendente em dinheiro com essa pessoa.");
    openDialog(settleFormHtml(pair, eid));
  },
  "pick-receipt": async (el) => {
    // escolhe o arquivo e guarda em memória até o formulário ser enviado
    let payload;
    try { payload = await pickAndCompressReceipt(); } catch (e) { return toast(e.message, 4500); }
    if (!payload) return;
    state.pendingReceipt = payload;
    const status = el.closest("form")?.querySelector("[data-receipt-status]");
    if (status) status.textContent = `✓ ${payload.name} (${Math.max(1, Math.round(payload.bytes / 1024))} KB)`;
    el.textContent = "📎 Trocar comprovante";
  },
  "check-all": (el) => {
    const boxes = [...el.closest("form").querySelectorAll('input[name="split"]')];
    const all = boxes.every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !all));
  },

  "fridge-new": () => openDialog(fridgeFormHtml()),
  "fridge-delete": async (el) => {
    const e = state.fridge.find((x) => x.id === el.dataset.id);
    if (!e) return;
    if (!(await confirmDialog(`Excluir o lançamento de ${e.qty}× ${e.item}?`, "Excluir"))) return;
    write(() => deleteDoc(doc(col("fridge"), e.id)), "Lançamento excluído");
  },
  "return-items": async (el) => {
    const { debtor, creditor, item, qty } = el.dataset;
    const who = debtor === state.mid ? "Você devolveu" : `${nameOf(debtor)} devolveu`;
    if (!(await confirmDialog(`${who} ${qty}× ${item} pra ${nameOf(creditor)}? Isso zera esse item entre vocês.`, "Confirmar"))) return;
    write(() => addFridgeEntry({ kind: "devolveu", from: debtor, to: creditor, item, qty: Number(qty), note: "" }), `${qty}× ${item} devolvido`);
  },
  step: (el) => {
    const input = field(el.closest("form"), "qty");
    const n = Math.max(1, (parseInt(input.value, 10) || 1) + Number(el.dataset.delta));
    input.value = n;
  },
  "pick-treasurer": () => {
    if (!requireAdmin()) return;
    openDialog(`
      <div class="sheet">
        <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
        <h2>Quem recebe as contas?</h2>
        <p class="muted small">Aluguel, água e luz são pagos por essa pessoa; os outros transferem a parte deles pra ela.</p>
        <div class="btn-list">
          ${activeMembers().map((m) => `<button class="btn" data-action="set-treasurer" data-id="${m.id}"><span class="avatar">${esc(initials(m.name))}</span>${esc(m.name)}${m.id === state.mid ? ' <span class="muted small">(você)</span>' : ""}</button>`).join("")}
        </div>
      </div>`);
  },
  "share-general": () => openShareDialog("Resumo pro grupo", buildGeneralMessage()),
  "share-month": () => openShareDialog(`Resumo de ${monthLabel(state.month)}`, buildMonthMessage(state.month)),
  "share-copy": async () => {
    toast((await copyText(state.shareText || "")) ? "Mensagem copiada! Cole no WhatsApp." : "Não consegui copiar. Selecione o texto e copie.", 3000);
  },
  "share-wa": async () => {
    const text = state.shareText || "";
    if (navigator.share) {
      try { await navigator.share({ text }); } catch { /* cancelou */ }
    } else {
      window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
    }
  },

  "event-new": () => openDialog(eventFormHtml(null)),
  "event-open": (el) => { state.openEvent = el.dataset.id; subscribeEvent(el.dataset.id); window.scrollTo(0, 0); render(); },
  "event-back": () => { state.openEvent = null; render(); },
  "event-edit": (el) => { const e = state.events.get(el.dataset.id); if (e?.doc) openDialog(eventFormHtml(e)); },
  "event-delete": async (el) => {
    const e = state.events.get(el.dataset.id);
    if (!e?.doc) return;
    if (!(amAdmin() || e.doc.createdBy === state.mid)) return toast("Só o administrador ou quem criou o evento pode excluí-lo.", 3500);
    if (!(await confirmDialog(`Excluir “${e.doc.name}” com todas as despesas e comprovantes? Os convidados perdem o acesso.`, "Excluir"))) return;
    state.openEvent = null;
    deleteEvent(e);
    render();
  },
  "event-link": async (el) => {
    const e = state.events.get(el.dataset.id);
    if (!e?.doc) return;
    const url = eventLink(el.dataset.id);
    const text = `Link do evento “${e.doc.name}” (${dateBR(e.doc.date)}): abre, escolhe seu nome e veja sua parte:`;
    if (navigator.share) {
      try { await navigator.share({ title: e.doc.name, text, url }); return; } catch { /* cancelou */ }
    }
    toast((await copyText(url)) ? "Link do evento copiado! Mande pros convidados." : "Não consegui copiar.", 3500);
  },
  "share-event": (el) => { const e = state.events.get(el.dataset.id); if (e?.doc) openShareDialog(`Resumo · ${e.doc.name}`, buildEventMessage(e)); },
  "participant-add-members": (el) => { const e = state.events.get(el.dataset.id); if (e?.doc) openDialog(participantsFormHtml(e)); },
  "participant-add-guest": (el) => { const e = state.events.get(el.dataset.id); if (e?.doc) openDialog(guestFormHtml(e)); },
  "participant-remove": async (el) => {
    const e = state.events.get(el.dataset.eid);
    const p = e?.doc?.participants?.[el.dataset.id];
    if (!p) return;
    if (!(await confirmDialog(`Remover ${p.name} do evento?`, "Remover"))) return;
    write(() => removeParticipant(el.dataset.eid, el.dataset.id), `${p.name} removido`);
  },
  "expense-new": (el) => { const e = state.events.get(el.dataset.id); if (e?.doc) openDialog(expenseFormHtml(e)); },
  "expense-open": (el) => {
    const c = resolveCtx(el.dataset.ctx);
    if (c) openDialog(expenseDetailHtml(state.events.get(c.eid), c.entry), { detail: c.ctx });
  },
  "expense-edit": (el) => {
    const c = resolveCtx(el.dataset.ctx);
    if (c) openDialog(expenseFormHtml(state.events.get(c.eid), c.entry));
  },
  "expense-delete": async (el) => {
    const c = resolveCtx(el.dataset.ctx);
    if (!c) return;
    if (!(await confirmDialog(`Excluir “${c.entry.title}”? Apaga também quem já pagou e os comprovantes.`, "Excluir"))) return;
    closeDialog();
    write(() => deleteLedger(c.ctx), "Despesa excluída");
  },
  "guest-pick": (el) => {
    state.guest = { eid: state.eid, pid: el.dataset.id };
    localStorage.setItem(LS.guest, JSON.stringify(state.guest));
    render();
  },
  "guest-switch": () => { state.guest = null; localStorage.removeItem(LS.guest); render(); },
  "guest-exit": () => { localStorage.removeItem(LS.guest); localStorage.removeItem(LS.event); location.reload(); },

  "member-new": () => { if (requireAdmin()) openDialog(memberFormHtml({ mode: "new" })); },
  "member-delete": async (el) => {
    if (!requireAdmin()) return;
    const m = memberById(el.dataset.id);
    if (!m) return;
    if (m.id === state.mid) return toast("Você não pode excluir a si mesmo.");
    if (state.group?.treasurer === m.id) return toast("Essa pessoa é a responsável pelas contas. Troque o responsável antes.", 3500);
    const ok = await confirmDialog(`Excluir ${m.name} do grupo? A pessoa perde o acesso e sai das divisões. Contas e lançamentos antigos continuam registrados.`, "Excluir");
    if (!ok) return;
    closeDialog();
    // guarda o nome pra o histórico não ficar com "?" e apaga o cadastro
    write(() => updateDoc(groupRef(), { [`removedNames.${m.id}`]: m.name }));
    write(() => deleteDoc(doc(col("members"), m.id)), `${m.name} excluído do grupo`);
  },
  "member-admin": async (el) => {
    if (!requireAdmin()) return;
    const m = memberById(el.dataset.id);
    if (!m) return;
    const makeAdmin = !isAdmin(m.id);
    if (!makeAdmin && admins().filter((a) => a.id !== m.id).length === 0) return toast("O grupo precisa de pelo menos um administrador.", 3000);
    const text = makeAdmin
      ? `Tornar ${m.name} administrador? Vai poder excluir integrantes, redefinir PINs, definir o responsável e renomear o grupo.`
      : `Remover ${m.name} da administração?`;
    if (!(await confirmDialog(text, "Confirmar"))) return;
    closeDialog();
    write(() => updateDoc(doc(col("members"), m.id), { admin: makeAdmin }), makeAdmin ? `${m.name} agora é administrador` : `${m.name} não é mais administrador`);
  },
  "member-open": (el) => {
    const m = memberById(el.dataset.id);
    if (m) openDialog(memberSheetHtml(m), { detail: null });
  },
  "member-pin": (el) => {
    const m = memberById(el.dataset.id);
    if (!m) return;
    if (m.id !== state.mid && !requireAdmin()) return;
    openDialog(memberFormHtml({ mode: m.id === state.mid ? "mypin" : "pin", member: m }));
  },
  "member-pix": () => openDialog(memberFormHtml({ mode: "pix", member: me() })),
  "member-active": (el) => {
    const m = memberById(el.dataset.id);
    if (!m) return;
    const active = el.checked;
    if (!requireAdmin()) { el.checked = !active; return; }
    if (!active && m.id === state.mid) {
      el.checked = true;
      return toast("Você não pode se desativar. Peça pra outra pessoa.");
    }
    if (!active && state.group?.treasurer === m.id) {
      el.checked = true;
      return toast("Essa pessoa é a responsável pelas contas. Troque o responsável antes.");
    }
    write(() => updateDoc(doc(col("members"), m.id), { active }), active ? `${m.name} ativado` : `${m.name} desativado`);
  },
  "set-treasurer": async (el) => {
    if (!requireAdmin()) return;
    const m = memberById(el.dataset.id);
    if (!m) return;
    if (!(await confirmDialog(`Tornar ${m.name} o responsável pelas contas? Toda conta nova virá com ${m.name} como quem recebe.`, "Confirmar"))) return;
    closeDialog();
    write(() => updateDoc(groupRef(), { treasurer: m.id }), `${m.name} agora é o responsável pelas contas`);
  },
  "group-rename": () => {
    if (!requireAdmin()) return;
    openDialog(`
      <div class="sheet">
        <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
        <h2>Renomear grupo</h2>
        <form data-form="group-rename">
          <label class="field"><span>Nome</span><input type="text" name="name" required maxlength="40" value="${esc(state.group.name)}" autocomplete="off"></label>
          <button class="btn btn-primary btn-block" type="submit">Salvar</button>
        </form>
      </div>`);
  },
  "copy-link": async () => {
    try { await navigator.clipboard.writeText(inviteLink()); toast("Link copiado!"); }
    catch { toast("Não consegui copiar. Selecione o link e copie manualmente.", 3500); }
  },
  "share-link": async () => {
    try { await navigator.share({ title: state.group.name, text: `Entra no grupo “${state.group.name}” pra gente dividir as contas da sede:`, url: inviteLink() }); }
    catch { /* usuário cancelou */ }
  },
};

const forms = {
  "create-group": (form) => {
    const name = field(form, "name").value.trim();
    if (!name) return;
    form.querySelector("button").disabled = true;
    field(form, "name").blur();
    const { gid, p } = createGroup(name);
    p.catch((e) => { console.error(e); toast("Não foi salvo: " + (e.code || e.message), 4000); });
    localStorage.setItem(LS.gid, gid);
    localStorage.removeItem(LS.session);
    state.gid = gid;
    state.group = undefined;
    state.mid = null;
    subscribeAll();
    render();
    toast("Grupo criado! Agora cadastre você.");
  },
  login: async (form) => {
    const pin = field(form, "pin").value.trim();
    if (!/^\d{4}$/.test(pin)) { state.loginError = "O PIN tem 4 números."; field(form, "pin").blur(); return render(); }
    if (await checkPin(state.loginPick, pin)) {
      state.mid = state.loginPick;
      state.loginPick = null;
      state.loginError = "";
      state.tab = "home";
      saveSession();
      field(form, "pin").blur();
      render();
    } else {
      state.loginError = "PIN incorreto.";
      field(form, "pin").blur();
      render();
      $("input.pin")?.classList.add("shake");
    }
  },
  member: async (form) => {
    const mode = form.dataset.mode;
    if (mode === "pix") {
      const pix = field(form, "pix").value.trim();
      if (write(() => updateDoc(doc(col("members"), state.mid), { pix }), pix ? "Chave Pix salva" : "Chave Pix removida")) closeDialog();
      return;
    }
    const pin = field(form, "pin").value.trim();
    const pin2 = field(form, "pin2").value.trim();
    if (!/^\d{4}$/.test(pin)) return showFormError(form, "O PIN precisa ter 4 números.");
    if (pin !== pin2) return showFormError(form, "Os PINs não conferem.");
    if (mode === "new" || mode === "signup") {
      const name = field(form, "name").value.trim();
      if (!name) return showFormError(form, "Digite um nome.");
      if (state.members.some((m) => m.name.localeCompare(name, "pt-BR", { sensitivity: "base" }) === 0)) {
        return showFormError(form, "Já existe alguém com esse nome.");
      }
      if (mode === "new" && !requireAdmin()) return;
      const { mid, data } = await newMemberDoc(name, pin);
      data.pix = field(form, "pix").value.trim();
      if (mode === "signup" && state.members.length === 0) data.admin = true; // quem cria o grupo é o admin
      if (!write(() => setDoc(doc(col("members"), mid), data), mode === "new" ? `${name} adicionado` : `Bem-vindo, ${name}!`)) return;
      closeDialog();
      if (mode === "signup") { state.mid = mid; state.loginPick = null; state.tab = "home"; saveSession(); render(); }
      return;
    }
    if (mode === "mypin") {
      if (!(await checkPin(state.mid, field(form, "current").value.trim()))) return showFormError(form, "PIN atual incorreto.");
      const hash = await pinHash(state.gid, state.mid, pin);
      if (write(() => updateDoc(doc(col("members"), state.mid), { pinHash: hash }), "PIN alterado")) closeDialog();
      return;
    }
    if (mode === "pin") {
      if (!requireAdmin()) return;
      const hash = await pinHash(state.gid, form.dataset.id, pin);
      if (write(() => updateDoc(doc(col("members"), form.dataset.id), { pinHash: hash }), "PIN redefinido")) closeDialog();
    }
  },
  bill: (form) => {
    const category = field(form, "category").value;
    const title = field(form, "title").value.trim();
    const month = field(form, "month").value;
    const amount = Number(field(form, "amount").dataset.cents || 0);
    const paidBy = field(form, "paidBy").value;
    const splitAmong = [...form.querySelectorAll('input[name="split"]:checked')].map((i) => i.value);
    if (!title) return showFormError(form, "Dê uma descrição pra conta.");
    if (amount <= 0) return showFormError(form, "Informe o valor.");
    if (!splitAmong.length) return showFormError(form, "Escolha pelo menos uma pessoa pra dividir.");
    if (!splitAmong.includes(paidBy)) splitAmong.push(paidBy);
    const id = form.dataset.id || null;
    const notes = field(form, "notes").value.trim();
    if (!write(() => saveBill(id, { category, title, month, amount, paidBy, splitAmong, notes }), id ? "Conta atualizada" : "Conta lançada")) return;
    closeDialog();
    state.month = month;
    render();
  },
  fridge: (form) => {
    const kind = field(form, "kind").value;
    const a = field(form, "a").value, b = field(form, "b").value;
    const item = field(form, "item").value.trim();
    const qty = parseInt(field(form, "qty").value, 10) || 0;
    const note = field(form, "note").value.trim();
    if (!a || !b) return showFormError(form, "Escolha as duas pessoas.");
    if (a === b) return showFormError(form, "Escolha duas pessoas diferentes.");
    if (!item) return showFormError(form, "Diga o que foi pego (ex.: Heineken).");
    if (qty < 1) return showFormError(form, "Quantidade mínima: 1.");
    // pegou: a pegou de b => item fluiu de b para a. devolveu: a devolveu pra b => fluiu de a para b.
    const entry = kind === "pegou"
      ? { kind, from: b, to: a, item, qty, note }
      : { kind, from: a, to: b, item, qty, note };
    if (write(() => addFridgeEntry(entry), "Lançado!")) closeDialog();
  },
  event: (form) => {
    const name = field(form, "name").value.trim();
    const date = field(form, "date").value;
    if (!name || !date) return;
    const id = form.dataset.id;
    if (id) { updateEventMeta(id, { name, date }); closeDialog(); return; }
    const eid = createEvent(name, date);
    closeDialog();
    state.openEvent = eid;
    subscribeEvent(eid);
    render();
  },
  participants: (form) => {
    const eid = form.dataset.id;
    const mids = [...form.querySelectorAll('input[name="mid"]:checked')].map((i) => i.value);
    if (!mids.length) return closeDialog();
    const list = mids.map((mid) => { const m = memberById(mid); return { pid: mid, name: m.name, member: true, pix: m.pix || "" }; });
    if (write(() => addParticipants(eid, list), `${list.length} integrante${list.length === 1 ? "" : "s"} adicionado${list.length === 1 ? "" : "s"}`)) closeDialog();
  },
  guest: (form) => {
    const eid = form.dataset.id;
    const name = field(form, "name").value.trim();
    const pix = field(form, "pix").value.trim();
    if (!name) return;
    const ev = state.events.get(eid)?.doc;
    if (evParts(ev).some((p) => p.name.localeCompare(name, "pt-BR", { sensitivity: "base" }) === 0)) return showFormError(form, "Já existe alguém com esse nome no evento.");
    if (write(() => addParticipants(eid, [{ pid: randomId(12), name, member: false, pix }]), `${name} adicionado`)) closeDialog();
  },
  expense: (form) => {
    const eid = form.dataset.eid;
    const title = field(form, "title").value.trim();
    const amount = Number(field(form, "amount").dataset.cents || 0);
    const paidBy = field(form, "paidBy").value;
    const splitAmong = [...form.querySelectorAll('input[name="split"]:checked')].map((i) => i.value);
    const notes = field(form, "notes").value.trim();
    if (!title) return showFormError(form, "Diga o que foi comprado.");
    if (amount <= 0) return showFormError(form, "Informe o valor.");
    if (!splitAmong.length) return showFormError(form, "Escolha pelo menos uma pessoa pra dividir.");
    if (!splitAmong.includes(paidBy)) splitAmong.push(paidBy);
    const id = form.dataset.id || null;
    if (write(() => saveExpense(eid, id, { title, amount, paidBy, splitAmong, notes }), id ? "Despesa atualizada" : "Despesa lançada")) closeDialog();
  },
  settle: (form) => {
    const eid = form.dataset.eid || "";
    const pair = eid ? findEventPair(eid, form.dataset.a, form.dataset.b) : findPair(form.dataset.a, form.dataset.b);
    if (!pair || pair.moneyNet === 0) { closeDialog(); return toast("Nada pendente em dinheiro com essa pessoa."); }
    // o comprovante vai pra coleção do primeiro lançamento do devedor (conta do grupo ou evento)
    const debtor = pair.moneyNet > 0 ? pair.a : pair.b;
    const first = pair.shares.find((x) => x.from === debtor);
    const receipts = first ? resolveCtx(first.ctx)?.receipts : null;
    const receiptId = state.pendingReceipt && receipts ? saveReceipt(state.pendingReceipt, receipts) : null;
    settlePair(pair, receiptId);
    closeDialog();
    const other = pair.a === actorId() ? pair.b : pair.a;
    toast(`Acerto com ${eid ? pName(state.events.get(eid)?.doc, other) : nameOf(other)} registrado!`);
  },
  "group-rename": (form) => {
    if (!requireAdmin()) return;
    const name = field(form, "name").value.trim();
    if (!name) return;
    if (write(() => updateDoc(groupRef(), { name }), "Grupo renomeado")) closeDialog();
  },
};

// ---------------------------------------------------------------- eventos

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.matches('input[type="checkbox"]')) return; // tratado no change
  // clique num controle interno (sem ação própria) não dispara a ação do card
  const inner = e.target.closest("button, label, input, select, a, details, summary");
  if (inner && inner !== el && el.contains(inner)) return;
  e.preventDefault();
  actions[el.dataset.action]?.(el, e);
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.matches('input[type="checkbox"][data-action]')) {
    actions[el.dataset.action]?.(el, e);
    return;
  }
  // formulário de conta: trocar categoria preenche a descrição
  if (el.matches('input[name="category"]')) {
    const title = field(el.form, "title");
    const known = Object.values(CATEGORIES).map((c) => c.label);
    if (!title.value || known.includes(title.value)) title.value = el.value === "extra" ? "" : CATEGORIES[el.value].label;
    if (el.value === "extra") title.focus();
  }
  // formulário da geladeira: trocar tipo ajusta os rótulos
  if (el.matches('input[name="kind"]')) {
    const f = el.form;
    $("[data-label-a]", f).textContent = el.value === "pegou" ? "Quem pegou" : "Quem devolveu";
    $("[data-label-b]", f).textContent = el.value === "pegou" ? "De quem" : "Pra quem";
  }
});

// máscara de dinheiro: digita só números, mostra R$ 0,00
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.matches("input.money")) return;
  const digits = el.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, 10);
  const cents = Number(digits || 0);
  el.dataset.cents = cents;
  el.value = fmt(cents);
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(form);
});

// lembrar quais duplas estão expandidas no dashboard (toggle não borbulha: captura)
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.pair) return;
  if (d.open) state.openPairs.add(d.dataset.pair);
  else state.openPairs.delete(d.dataset.pair);
}, true);

// fechar dialog ao tocar fora
$("#dlg").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeDialog();
});
$("#dlg").addEventListener("close", () => { state.openDetail = null; });
$("#confirm").addEventListener("close", () => settleConfirm(false));

// online / offline
const offline = $("#offline");
const syncOnline = () => (offline.hidden = navigator.onLine);
window.addEventListener("online", syncOnline);
window.addEventListener("offline", syncOnline);
syncOnline();

boot();
