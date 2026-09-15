// Sede — rateio de contas + geladeira compartilhada
// Vanilla JS + Firebase (Firestore) via CDN. Sem build.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------------------------------------------------------------- constantes

const LS = { gid: "sede.gid", session: "sede.session", tab: "sede.tab" };

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
const field = (form, name) => form.elements[name]; // form.name / form.title colidem com props do <form>
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
  unsubs: [],
  fatal: null,
};

const me = () => state.members.find((m) => m.id === state.mid) || null;
const memberById = (id) => state.members.find((m) => m.id === id);
const nameOf = (id) => memberById(id)?.name || "?";
const activeMembers = () => state.members.filter((m) => m.active !== false);

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
      state.fridge = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.ready.fridge = true;
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

function toggleShare(billId, mid) {
  const bill = state.bills.find((b) => b.id === billId);
  const share = bill?.shares?.[mid];
  if (!bill || !share || mid === bill.paidBy) return Promise.resolve();
  const paid = !share.paid;
  return updateDoc(doc(col("bills"), billId), {
    [`shares.${mid}.paid`]: paid,
    [`shares.${mid}.paidAt`]: paid ? Date.now() : null,
    [`shares.${mid}.markedBy`]: paid ? state.mid : null,
  });
}

function duplicateBill(bill) {
  const month = addMonths(bill.month, 1);
  const split = bill.splitAmong.filter((m) => memberById(m)?.active !== false);
  const splitAmong = split.includes(bill.paidBy) ? split : [...split, bill.paidBy];
  return saveBill(null, { ...bill, month, splitAmong, notes: "" });
}

// --- geladeira

function addFridgeEntry({ kind, from, to, amount, description }) {
  return setDoc(doc(col("fridge")), {
    kind, from, to, amount,
    description: description || "",
    createdBy: state.mid,
    createdAt: Date.now(),
  });
}

/** Saldos líquidos por dupla. Retorna { "a|b": valor } com a < b; valor > 0 => a deve b. */
function pairBalances() {
  const owes = {}; // owes[x][y] = quanto x deve y (bruto)
  for (const e of state.fridge) {
    // valor fluiu de `from` para `to`: `to` passa a dever `from`
    owes[e.to] ??= {};
    owes[e.to][e.from] = (owes[e.to][e.from] || 0) + e.amount;
  }
  const ids = new Set();
  for (const x in owes) for (const y in owes[x]) { ids.add(x); ids.add(y); }
  const list = [...ids].sort();
  const pairs = {};
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const net = (owes[a]?.[b] || 0) - (owes[b]?.[a] || 0);
      if (net !== 0) pairs[`${a}|${b}`] = net;
    }
  }
  return pairs;
}

/** Lista [{other, amount}] do ponto de vista de `mid`: amount > 0 => mid deve other. */
function balancesFor(mid) {
  const out = [];
  for (const [key, net] of Object.entries(pairBalances())) {
    const [a, b] = key.split("|");
    if (a === mid) out.push({ other: b, amount: net });
    else if (b === mid) out.push({ other: a, amount: -net });
  }
  return out.sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
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
    history.replaceState(null, "", location.pathname + location.search);
  }
  state.gid = localStorage.getItem(LS.gid);

  try {
    await initFirebase();
  } catch (e) {
    console.error(e);
    state.fatal = e.message === "config" ? "config" : "conn";
    render();
    return;
  }

  if (state.gid) {
    const sess = JSON.parse(localStorage.getItem(LS.session) || "null");
    if (sess?.gid === state.gid) state.mid = sess.mid;
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
      <h1 class="center" style="padding:0">Sede</h1>
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
  if (!state.gid) return renderSetup(root);
  if (state.group === null) return renderGroupMissing(root);
  if (!state.ready.members || state.group === undefined) {
    root.innerHTML = `<div class="center muted">Carregando…</div>`;
    return;
  }
  if (!me()) return renderLogin(root);

  tabbar.hidden = false;
  tabbar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  const views = { home: renderHome, bills: renderBills, fridge: renderFridge, people: renderPeople };
  root.innerHTML = topbar() + (views[state.tab] || renderHome)();

  if (state.openDetail && $("#dlg").open) {
    const bill = state.bills.find((b) => b.id === state.openDetail);
    if (bill) $("#dlg").innerHTML = billDetailHtml(bill);
    else closeDialog();
  }
}

function topbar() {
  const m = me();
  return `
    <div class="topbar">
      <div>
        <h1>${esc(state.group?.name || "Sede")}</h1>
        <div class="who">Você é <b>${esc(m.name)}</b></div>
      </div>
      <div class="avatar">${esc(initials(m.name))}</div>
    </div>`;
}

// --- telas iniciais

function renderSetup(root) {
  root.innerHTML = `
    <div class="logo">🍻</div>
    <h1 class="center" style="padding:0 0 4px">Sede</h1>
    <p class="center muted" style="padding:0 0 20px">Rateio das contas do espaço e controle da geladeira.</p>
    <div class="card">
      <h2>Criar um grupo novo</h2>
      <form data-form="create-group">
        <label class="field"><span>Nome do grupo</span>
          <input type="text" name="name" required maxlength="40" placeholder="Ex.: Sede dos amigos" autocomplete="off">
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
  const myPending = [];
  const toReceive = [];
  for (const b of state.bills) {
    const s = b.shares?.[state.mid];
    if (s && !s.paid && b.paidBy !== state.mid) myPending.push({ bill: b, share: s });
    if (b.paidBy === state.mid) {
      for (const [mid, sh] of Object.entries(b.shares || {})) {
        if (!sh.paid && mid !== state.mid) toReceive.push({ bill: b, mid, share: sh });
      }
    }
  }
  const pendingTotal = myPending.reduce((a, x) => a + x.share.amount, 0);
  const receiveTotal = toReceive.reduce((a, x) => a + x.share.amount, 0);
  const balances = balancesFor(state.mid);
  const cm = currentMonth();
  const monthBills = state.bills.filter((b) => b.month === cm);
  const monthTotal = monthBills.reduce((a, b) => a + b.amount, 0);
  const myMonth = monthBills.reduce((a, b) => a + (b.shares?.[state.mid]?.amount || 0), 0);
  const monthShares = monthBills.flatMap((b) => Object.values(b.shares || {}));
  const monthPaid = monthShares.filter((s) => s.paid).length;

  return `
    <div class="card">
      <div class="card-title"><h2>Suas contas pendentes</h2>${myPending.length ? `<span class="chip danger">${fmt(pendingTotal)}</span>` : ""}</div>
      ${myPending.length ? myPending.map(({ bill, share }) => `
        <div class="row">
          <span class="ico">${CATEGORIES[bill.category]?.icon || "🧾"}</span>
          <div class="grow">
            <div class="ellipsis">${esc(bill.title)}</div>
            <div class="sub">${monthLabel(bill.month)} · pagar pra ${esc(nameOf(bill.paidBy))}</div>
          </div>
          <span class="amt">${fmt(share.amount)}</span>
          <button class="btn btn-sm" data-action="toggle-share" data-bill="${bill.id}" data-mid="${state.mid}">Paguei</button>
        </div>`).join("") : `<div class="empty"><div class="big">🎉</div>Tudo pago!</div>`}
    </div>

    ${toReceive.length ? `
    <div class="card">
      <div class="card-title"><h2>A receber</h2><span class="chip warn">${fmt(receiveTotal)}</span></div>
      <p class="small muted">Partes das contas que você pagou e ainda não recebeu.</p>
      ${toReceive.map(({ bill, mid, share }) => `
        <div class="row">
          <span class="avatar">${esc(initials(nameOf(mid)))}</span>
          <div class="grow">
            <div>${esc(nameOf(mid))}</div>
            <div class="sub">${esc(bill.title)} · ${monthLabel(bill.month)}</div>
          </div>
          <span class="amt">${fmt(share.amount)}</span>
          <button class="btn btn-sm" data-action="toggle-share" data-bill="${bill.id}" data-mid="${mid}">Recebi</button>
        </div>`).join("")}
    </div>` : ""}

    <div class="card tap" data-action="tab" data-tab="fridge">
      <div class="card-title"><h2>🍺 Geladeira</h2><span class="muted small">ver ›</span></div>
      ${balances.length ? balances.map((b) => balanceLine(b)).join("") : `<div class="empty">Tudo zerado 🍻</div>`}
    </div>

    <div class="card tap" data-action="tab" data-tab="bills">
      <div class="card-title"><h2>${cap(monthLabel(cm, true))}</h2><span class="muted small">ver ›</span></div>
      ${monthBills.length ? `
        <div class="row"><div class="grow">Total das contas</div><span class="amt">${fmt(monthTotal)}</span></div>
        <div class="row"><div class="grow">Sua parte</div><span class="amt">${fmt(myMonth)}</span></div>
        <div class="row"><div class="grow">Pagamentos</div><span class="chip ${monthPaid === monthShares.length ? "ok" : ""}">${monthPaid}/${monthShares.length}</span></div>
      ` : `<div class="empty">Nenhuma conta lançada este mês</div>`}
    </div>`;
}

function balanceLine({ other, amount }, withAction = false) {
  const n = esc(nameOf(other));
  const text = amount > 0
    ? `Você deve <b class="danger">${fmt(amount)}</b> pra ${n}`
    : `${n} te deve <b class="ok">${fmt(-amount)}</b>`;
  return `
    <div class="row">
      <span class="avatar">${esc(initials(nameOf(other)))}</span>
      <div class="grow">${text}</div>
      ${withAction && amount > 0 ? `<button class="btn btn-sm" data-action="settle" data-other="${other}" data-amount="${amount}">Acertar</button>` : ""}
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
    ${bills.length ? `<p class="muted small right">Total do mês: <b>${fmt(total)}</b></p>` : ""}
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
    return `
      <div class="row">
        <span class="avatar">${esc(initials(nameOf(mid)))}</span>
        <div class="grow">
          <div>${esc(nameOf(mid))}${mid === state.mid ? ' <span class="muted small">(você)</span>' : ""}</div>
          <div class="sub">${isPayer ? "pagou a conta" : s.paid ? `pago ${dateLabel(s.paidAt)}${s.markedBy ? " · por " + esc(nameOf(s.markedBy)) : ""}` : "pendente"}</div>
        </div>
        <span class="amt">${fmt(s.amount)}</span>
        <label class="switch"><input type="checkbox" data-action="toggle-share" data-bill="${b.id}" data-mid="${mid}" ${s.paid ? "checked" : ""} ${isPayer ? "disabled" : ""}><i></i></label>
      </div>`;
  }).join("");
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${CATEGORIES[b.category]?.icon || "🧾"} ${esc(b.title)}</h2>
      <p class="muted">${monthLabel(b.month, true)} · pago por <b>${esc(nameOf(b.paidBy))}</b></p>
      <div class="big-amount">${fmt(b.amount)}</div>
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
  const paidBy = b?.paidBy || state.mid;
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
        <label class="field"><span>Quem pagou a conta</span>
          <select name="paidBy">${pool.map((m) => `<option value="${m.id}" ${m.id === paidBy ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
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
  const mine = balancesFor(state.mid);
  const all = Object.entries(pairBalances()).map(([k, net]) => {
    const [a, b] = k.split("|");
    return net > 0 ? { debtor: a, creditor: b, amount: net } : { debtor: b, creditor: a, amount: -net };
  }).sort((x, y) => y.amount - x.amount);
  const others = all.filter((p) => p.debtor !== state.mid && p.creditor !== state.mid);
  const iOwe = mine.filter((b) => b.amount > 0).reduce((a, b) => a + b.amount, 0);
  const owedToMe = mine.filter((b) => b.amount < 0).reduce((a, b) => a - b.amount, 0);

  return `
    <div class="card">
      <div class="card-title"><h2>Seus saldos</h2>
        ${mine.length ? `<span class="small muted">${iOwe ? `deve ${fmt(iOwe)}` : ""}${iOwe && owedToMe ? " · " : ""}${owedToMe ? `a receber ${fmt(owedToMe)}` : ""}</span>` : ""}
      </div>
      ${mine.length ? mine.map((b) => balanceLine(b, true)).join("") : `<div class="empty"><div class="big">🍻</div>Tudo zerado com todo mundo.</div>`}
    </div>
    ${others.length ? `
    <div class="card">
      <details>
        <summary>Saldos entre os outros (${others.length})</summary>
        ${others.map((p) => `<div class="row"><div class="grow">${esc(nameOf(p.debtor))} deve <b>${fmt(p.amount)}</b> pra ${esc(nameOf(p.creditor))}</div></div>`).join("")}
      </details>
    </div>` : ""}
    <div class="card">
      <h2>Lançamentos</h2>
      ${state.fridge.length ? state.fridge.map(fridgeRow).join("") : `<div class="empty">Nenhum lançamento ainda.<br><span class="small">Pegou uma cerveja de alguém? Lança aqui.</span></div>`}
    </div>
    <button class="fab" data-action="fridge-new"><span class="plus">+</span> Lançar</button>`;
}

function fridgeRow(e) {
  // kind "pegou": `to` pegou de `from`. kind "pagou": `from` pagou pra `to`.
  const text = e.kind === "pegou"
    ? `<b>${esc(nameOf(e.to))}</b> pegou de <b>${esc(nameOf(e.from))}</b>`
    : `<b>${esc(nameOf(e.from))}</b> pagou pra <b>${esc(nameOf(e.to))}</b>`;
  return `
    <div class="row">
      <span class="ico">${e.kind === "pegou" ? "🍺" : "💸"}</span>
      <div class="grow">
        <div>${text}</div>
        <div class="sub">${dateLabel(e.createdAt)}${e.description ? " · " + esc(e.description) : ""}</div>
      </div>
      <span class="amt">${fmt(e.amount)}</span>
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
          <label><input type="radio" name="kind" value="pegou" ${kind === "pegou" ? "checked" : ""}><span>🍺 Pegou algo</span></label>
          <label><input type="radio" name="kind" value="pagou" ${kind === "pagou" ? "checked" : ""}><span>💸 Pagou alguém</span></label>
        </div>
        <label class="field"><span data-label-a>${kind === "pegou" ? "Quem pegou" : "Quem pagou"}</span>
          <select name="a">${opts(state.mid)}</select>
        </label>
        <label class="field"><span data-label-b>${kind === "pegou" ? "De quem" : "Pra quem"}</span>
          <select name="b">${opts(other)}</select>
        </label>
        <label class="field"><span>Valor</span>
          <input type="text" class="money" name="amount" inputmode="numeric" data-cents="${preset.amount || 0}" value="${fmt(preset.amount || 0)}" autocomplete="off">
        </label>
        <label class="field"><span>O quê (opcional)</span>
          <input type="text" name="description" maxlength="80" placeholder="${kind === "pegou" ? "Ex.: 2 latas de Heineken" : "Ex.: acerto do mês"}" value="${esc(preset.description || "")}" autocomplete="off">
        </label>
        <div class="error" data-error hidden></div>
        <button class="btn btn-primary btn-block" type="submit">Lançar</button>
      </form>
    </div>`;
}

// --- Galera

function renderPeople() {
  const link = inviteLink();
  return `
    <div class="card">
      <div class="card-title"><h2>Integrantes</h2><button class="btn btn-sm" data-action="member-new">+ Adicionar</button></div>
      ${state.members.map((m) => `
        <div class="row">
          <span class="avatar">${esc(initials(m.name))}</span>
          <div class="grow">
            <div>${esc(m.name)}${m.id === state.mid ? ' <span class="muted small">(você)</span>' : ""}</div>
            <div class="sub">${m.active === false ? "inativo — fora das divisões" : "ativo"}</div>
          </div>
          <button class="btn btn-sm btn-ghost" data-action="member-pin" data-id="${m.id}" title="PIN" aria-label="PIN">🔑</button>
          <label class="switch" title="Ativo"><input type="checkbox" data-action="member-active" data-id="${m.id}" ${m.active !== false ? "checked" : ""}><i></i></label>
        </div>`).join("")}
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
      <div class="row"><div class="grow">${esc(state.group.name)}</div><button class="btn btn-sm" data-action="group-rename">Renomear</button></div>
      <div class="row"><div class="grow">Sair da sua conta neste aparelho</div><button class="btn btn-sm" data-action="logout">Sair</button></div>
    </div>`;
}

function memberFormHtml({ mode, member }) {
  // mode: "new" | "signup" | "pin" (redefinir de alguém) | "mypin" (trocar o meu)
  const titles = { new: "Adicionar integrante", signup: "Me cadastrar", pin: `Redefinir PIN de ${member?.name || ""}`, mypin: "Trocar meu PIN" };
  return `
    <div class="sheet">
      <button class="close" data-action="dlg-close" aria-label="Fechar">✕</button>
      <h2>${esc(titles[mode])}</h2>
      <form data-form="member" data-mode="${mode}" data-id="${member?.id || ""}">
        ${mode === "new" || mode === "signup" ? `
          <label class="field"><span>Nome</span><input type="text" name="name" required maxlength="30" placeholder="Como a galera te chama" autocomplete="off"></label>` : ""}
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
function openDialog(html) {
  const d = dlg();
  d.innerHTML = html;
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}
function closeDialog() {
  state.openDetail = null;
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
    state.openDetail = b.id;
    openDialog(billDetailHtml(b));
  },
  "bill-edit": (el) => {
    const b = state.bills.find((x) => x.id === el.dataset.id);
    if (!b) return;
    state.openDetail = null;
    openDialog(billFormHtml(b));
  },
  "bill-delete": async (el) => {
    const b = state.bills.find((x) => x.id === el.dataset.id);
    if (!b) return;
    if (!(await confirmDialog(`Excluir “${b.title}” de ${monthLabel(b.month)}? Isso apaga também quem já pagou.`, "Excluir"))) return;
    closeDialog();
    write(() => deleteDoc(doc(col("bills"), b.id)), "Conta excluída");
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
  "toggle-share": (el) => {
    write(() => toggleShare(el.dataset.bill, el.dataset.mid));
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
    if (!(await confirmDialog(`Excluir este lançamento de ${fmt(e.amount)}?`, "Excluir"))) return;
    write(() => deleteDoc(doc(col("fridge"), e.id)), "Lançamento excluído");
  },
  settle: (el) => openDialog(fridgeFormHtml({ kind: "pagou", other: el.dataset.other, amount: Number(el.dataset.amount), description: "acerto" })),

  "member-new": () => openDialog(memberFormHtml({ mode: "new" })),
  "member-pin": (el) => {
    const m = memberById(el.dataset.id);
    if (!m) return;
    openDialog(memberFormHtml({ mode: m.id === state.mid ? "mypin" : "pin", member: m }));
  },
  "member-active": (el) => {
    const m = memberById(el.dataset.id);
    if (!m) return;
    const active = el.checked;
    if (!active && m.id === state.mid) {
      el.checked = true;
      return toast("Você não pode se desativar. Peça pra outra pessoa.");
    }
    write(() => updateDoc(doc(col("members"), m.id), { active }), active ? `${m.name} ativado` : `${m.name} desativado`);
  },
  "group-rename": () => {
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
      const { mid, data } = await newMemberDoc(name, pin);
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
    const amount = Number(field(form, "amount").dataset.cents || 0);
    const description = field(form, "description").value.trim();
    if (!a || !b) return showFormError(form, "Escolha as duas pessoas.");
    if (a === b) return showFormError(form, "Escolha duas pessoas diferentes.");
    if (amount <= 0) return showFormError(form, "Informe o valor.");
    // pegou: a pegou de b => valor fluiu de b para a. pagou: a pagou pra b => fluiu de a para b.
    const entry = kind === "pegou"
      ? { kind, from: b, to: a, amount, description }
      : { kind, from: a, to: b, amount, description };
    if (write(() => addFridgeEntry(entry), "Lançado!")) closeDialog();
  },
  "group-rename": (form) => {
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
    $("[data-label-a]", f).textContent = el.value === "pegou" ? "Quem pegou" : "Quem pagou";
    $("[data-label-b]", f).textContent = el.value === "pegou" ? "De quem" : "Pra quem";
    field(f, "description").placeholder = el.value === "pegou" ? "Ex.: 2 latas de Heineken" : "Ex.: acerto do mês";
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
