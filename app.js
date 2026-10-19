import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getDatabase, ref, set, get, onValue, push, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const welcome = $("welcome"), workspace = $("workspace"), canvas = $("drawingCanvas");
const ctx = canvas.getContext("2d");
let app, auth, db, currentUser, roomId = null, strokes = {}, activeStroke = null;
let currentColor = "#292927", brushSize = 5, tool = "pen", drawing = false;
let canvasWidth = 0, canvasHeight = 0, unsubStrokes = null;
let lastWrite = 0, pendingPoints = null, toastTimer, remoteLive = {}, unsubLive = null;

const params = new URLSearchParams(location.search);
const urlRoom = params.get("room");
const configReady = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PASTE_") &&
  firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("PASTE_");

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function setConnection(online, message) {
  $("connectionDot").classList.toggle("online", online);
  $("connectionText").textContent = message;
}
function makeRoomId() {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
function safeRoomId(value) { return /^[a-zA-Z0-9_-]{6,80}$/.test(value || ""); }

async function initFirebase() {
  if (!configReady) {
    setConnection(false, "Потрібне налаштування Firebase");
    $("createRoom").disabled = true;
    $("createRoom").title = "Спочатку заповни firebase-config.js";
    $("joinForm").addEventListener("submit", e => { e.preventDefault(); toast("Спочатку налаштуй Firebase у firebase-config.js"); });
    toast("Заповни firebase-config.js за інструкцією в README.");
    return;
  }
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app); db = getDatabase(app);
    const credential = await signInAnonymously(auth);
    currentUser = credential.user;
    setConnection(true, "Ви в мережі");
    $("createRoom").addEventListener("click", createRoom);
    $("joinForm").addEventListener("submit", joinRoom);
    if (urlRoom && safeRoomId(urlRoom)) await openRoom(urlRoom);
  } catch (error) {
    console.error(error); setConnection(false, "Немає з’єднання");
    toast(firebaseError(error));
  }
}
function firebaseError(error) {
  const code = error?.code || "";
  if (code.includes("auth/operation-not-allowed")) return "У Firebase увімкни Authentication → Sign-in method → Anonymous.";
  if (code.includes("permission-denied")) return "Firebase Rules заборонили доступ. Перевір правила з README.";
  return "Помилка Firebase. Перевір конфігурацію та правила доступу.";
}
async function createRoom() {
  const id = makeRoomId();
  try {
    await set(ref(db, `rooms/${id}/meta`), { createdAt: serverTimestamp(), createdBy: currentUser.uid });
    history.replaceState(null, "", `${location.pathname}?room=${id}`);
    await openRoom(id);
    await copyInvite(true);
  } catch (error) { console.error(error); toast(firebaseError(error)); }
}
async function joinRoom(event) {
  event.preventDefault();
  const id = $("roomInput").value.trim();
  if (!safeRoomId(id)) { toast("Введи правильний код кімнати."); return; }
  try {
    const snap = await get(ref(db, `rooms/${id}/meta`));
    if (!snap.exists()) { toast("Такої кімнати не знайдено. Перевір код або посилання."); return; }
    history.replaceState(null, "", `${location.pathname}?room=${id}`);
    await openRoom(id);
  } catch (error) { console.error(error); toast(firebaseError(error)); }
}
async function openRoom(id) {
  roomId = id;
  welcome.classList.add("hidden"); workspace.classList.remove("hidden");
  $("roomLabel").textContent = `Кімната ${id.slice(0, 8)}…`;
  setupCanvas();
  if (unsubStrokes) unsubStrokes();
  if (unsubLive) unsubLive();
  unsubStrokes = onValue(ref(db, `rooms/${roomId}/strokes`), snap => {
    strokes = snap.val() || {};
    redrawCanvas();
    $("canvasHint").classList.toggle("gone", Object.keys(strokes).length > 0);
  }, error => toast(firebaseError(error)));
  unsubLive = onValue(ref(db, `rooms/${roomId}/live`), snap => {
    remoteLive = snap.val() || {};
    redrawCanvas();
  }, error => toast(firebaseError(error)));
}
async function copyInvite(silent = false) {
  try {
    await navigator.clipboard.writeText(location.href);
    if (!silent) toast("Посилання на кімнату скопійовано.");
    else toast("Кімнату створено! Посилання скопійовано — надішли його дівчині.");
  } catch { toast("Скопіюй посилання з адресного рядка браузера."); }
}
$("copyInvite").addEventListener("click", () => copyInvite(false));

function setupCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvasWidth = rect.width; canvasHeight = rect.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawCanvas();
}
function redrawCanvas() {
  if (!canvasWidth || !canvasHeight) return;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  for (const stroke of Object.values(strokes)) drawStroke(stroke);
  for (const stroke of Object.values(remoteLive)) {
    if (stroke && stroke.uid !== currentUser?.uid) drawStroke(stroke);
  }
  if (activeStroke) drawStroke(activeStroke);
}
function drawStroke(stroke) {
  if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return;
  const points = stroke.points;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.lineWidth = Number(stroke.size) || 5;
  ctx.strokeStyle = stroke.tool === "eraser" ? "#fffefa" : (stroke.color || "#292927");
  ctx.fillStyle = ctx.strokeStyle;
  if (points.length === 1) {
    ctx.beginPath(); ctx.arc(points[0].x * canvasWidth, points[0].y * canvasHeight, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(points[0].x * canvasWidth, points[0].y * canvasHeight);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * canvasWidth, points[i].y * canvasHeight);
    ctx.stroke();
  }
  ctx.restore();
}
function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
           y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
}
canvas.addEventListener("pointerdown", async event => {
  if (!roomId || !currentUser) return;
  event.preventDefault(); drawing = true; canvas.setPointerCapture(event.pointerId);
  activeStroke = { color: currentColor, size: brushSize, tool, uid: currentUser.uid, points: [pointFromEvent(event)], createdAt: Date.now() };
  redrawCanvas(); await writeActiveStroke(true);
});
canvas.addEventListener("pointermove", event => {
  if (!drawing || !activeStroke) return;
  event.preventDefault(); activeStroke.points.push(pointFromEvent(event)); redrawCanvas();
  const now = Date.now();
  if (now - lastWrite > 70) { lastWrite = now; writeActiveStroke(false); }
  else { pendingPoints = true; }
});
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
async function finishStroke() {
  if (!drawing || !activeStroke) return;
  drawing = false;
  const finished = activeStroke;
  activeStroke = null; pendingPoints = null;
  try {
    const strokeRef = push(ref(db, `rooms/${roomId}/strokes`));
    await set(strokeRef, finished);
    await remove(ref(db, `rooms/${roomId}/live/${currentUser.uid}`));
  } catch (error) { toast(firebaseError(error)); }
  redrawCanvas();
}
async function writeActiveStroke(isStart) {
  if (!roomId || !activeStroke) return;
  try {
    await set(ref(db, `rooms/${roomId}/live/${currentUser.uid}`), activeStroke);
  } catch (error) { console.error(error); }
}

document.querySelectorAll("[data-tool]").forEach(button => button.addEventListener("click", () => {
  tool = button.dataset.tool;
  document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("active", b === button));
}));
document.querySelectorAll("[data-color]").forEach(button => button.addEventListener("click", () => {
  currentColor = button.dataset.color;
  document.querySelectorAll("[data-color]").forEach(b => b.classList.toggle("selected", b === button));
  tool = "pen"; document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
}));
$("brushSize").addEventListener("input", event => { brushSize = Number(event.target.value); $("sizeValue").textContent = brushSize; });

$("clearBtn").addEventListener("click", () => $("clearDialog").showModal());
$("cancelClear").addEventListener("click", () => $("clearDialog").close());
$("confirmClear").addEventListener("click", async () => {
  $("clearDialog").close();
  try { await remove(ref(db, `rooms/${roomId}/strokes`)); await remove(ref(db, `rooms/${roomId}/live`)); toast("Полотно очищено для вас обох."); }
  catch (error) { toast(firebaseError(error)); }
});
$("undoBtn").addEventListener("click", async () => {
  if (!roomId) return;
  try {
    const snap = await get(ref(db, `rooms/${roomId}/strokes`));
    const all = snap.val() || {};
    const own = Object.entries(all).filter(([, s]) => s.uid === currentUser.uid).sort((a,b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    if (!own.length) { toast("Твоїх штрихів для скасування немає."); return; }
    await remove(ref(db, `rooms/${roomId}/strokes/${own[0][0]}`));
  } catch (error) { toast(firebaseError(error)); }
});
$("saveDrawing").addEventListener("click", () => {
  if (!canvasWidth || !canvasHeight) return;
  const link = document.createElement("a"); link.download = "nashe-pole.jpg";
  link.href = canvas.toDataURL("image/jpeg", .92); link.click();
});
window.addEventListener("resize", () => { if (roomId) setupCanvas(); });

initFirebase();
