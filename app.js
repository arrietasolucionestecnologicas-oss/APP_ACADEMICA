// CONFIGURACIÓN OBLIGATORIA
const GAS_URL = "https://script.google.com/macros/s/AKfycbyPIv-c9UqYflEdfiX1aCoCSHnNOz0qCGcXRkH8wxaRZd-c4bHYPOh0qbfkSJ5-Oij-/exec";
const APP_VERSION = "2026.09.27-2-sin-sw"; // se muestra en Ajustes para confirmar qué versión cargó tu celular

// --- INDEXEDDB V2 (SOPORTE DE BLOBS SEGURO) ---
const DB_NAME = 'IUBVaultDB_v2';
const DB_VERSION = 1;
const STORE_NAME = 'uploadQueue';

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'tempId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

async function addToQueue(payload) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        payload.tempId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        tx.objectStore(STORE_NAME).put(payload);
        tx.oncomplete = () => resolve(payload.tempId);
        tx.onerror = () => reject(tx.error);
    });
}
async function getQueue() {
    const db = await dbPromise;
    return new Promise((resolve) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result);
    });
}
async function removeFromQueue(tempId) {
    const db = await dbPromise;
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(tempId);
        tx.oncomplete = () => resolve();
    });
}

// --- UTILIDADES ---
function compressFileToBlob(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 1920;
                let width = img.width; let height = img.height;
                if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.8);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

function blobToBase64(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function localNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id_' + Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

// --- ESTADO GLOBAL ---
let sessionPin = localStorage.getItem('iubVaultPin') || "";
let localData = { modules: [], records: [] };
let isProcessingQueue = false;
let currentContext = { cuatrimestre: null, materia: null, tema: null };
let selectedCuatri = null;
let currentRecordId = null;
let modalContext = { list: [], index: -1 };
let composerMode = null; // 'comment' | 'text'
let composerRecordId = null;

function saveLocalData() {
    try {
        localStorage.setItem('iubVaultData_v2', JSON.stringify(localData));
    } catch (e) {
        showBanner("⚠️ Almacenamiento local lleno. Sincroniza y libera espacio.", "warn");
    }
}

// --- DOM ELEMENTS ---
const el = (id) => document.getElementById(id);
const loginScreen = el('loginScreen'), pinInput = el('pinInput'), btnLogin = el('btnLogin'), loginError = el('loginError');
const headerTitle = el('headerTitle'), btnSync = el('btnSync'), queueBadge = el('queueBadge'), syncIcon = el('syncIcon');
const connBanner = el('connBanner');
const installBanner = el('installBanner'), btnInstallApp = el('btnInstallApp'), btnDismissInstall = el('btnDismissInstall');
const btnBackToInicio = el('btnBackToInicio'), btnExportPDF = el('btnExportPDF');
const searchInput = el('searchInput'), cuatriChips = el('cuatriChips'), materiaGrid = el('materiaGrid'), searchResults = el('searchResults');
const temaChips = el('temaChips'), notebookFeed = el('notebookFeed');
const captureBar = el('captureBar'), bottomNav = el('bottomNav');
const composerStrip = el('composerStrip'), composerInput = el('composerInput'), btnComposerSend = el('btnComposerSend'), btnComposerDismiss = el('btnComposerDismiss');
const galleryInput = el('galleryInput'), cameraInput = el('cameraInput');

// --- BANNER DE ESTADO (conexión / sync) ---
let bannerTimeout = null;
function showBanner(msg, type = "info", persist = false) {
    connBanner.textContent = msg;
    connBanner.className = "text-center text-[11px] font-semibold py-1.5 shrink-0 " +
        (type === "warn" ? "bg-red-50 text-red-600" : type === "ok" ? "bg-green-50 text-green-600" : "bg-yellow-50 text-yellow-700");
    connBanner.classList.remove('hide');
    if (bannerTimeout) clearTimeout(bannerTimeout);
    if (!persist) bannerTimeout = setTimeout(() => connBanner.classList.add('hide'), 4000);
}
function hideBanner() { connBanner.classList.add('hide'); }

window.addEventListener('offline', () => showBanner("📡 Sin conexión. Tus capturas se guardan y se sincronizan al reconectar.", "warn", true));
window.addEventListener('online', () => { hideBanner(); if (sessionPin) { processQueue(); } });

// --- INICIALIZACIÓN ---
function initApp() {
    const cached = localStorage.getItem('iubVaultData_v2');
    if (cached) {
        try { localData = JSON.parse(cached); renderInicio(); }
        catch (e) { localData = { modules: [], records: [] }; }
    }
    if (!navigator.onLine) showBanner("📡 Sin conexión. Mostrando datos guardados.", "warn", true);

    if (sessionPin) {
        loginScreen.classList.add('hide');
        updateQueueBadge(); processQueue();
        if (navigator.onLine) validarPinRequest(sessionPin, true);
    } else {
        loginScreen.classList.remove('hide');
    }

    const versionTag = el('appVersionTag');
    if (versionTag) versionTag.textContent = 'Versión ' + APP_VERSION;

    // Nota: no se registra Service Worker. Después de varias pruebas, mezclar
    // versiones cacheadas de HTML/JS terminaba rompiendo la app en el celular.
    // Se prioriza que la app abra siempre con lo último del servidor.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    }
}

// Botón de emergencia: borra Service Worker + cachés y recarga desde cero.
el('btnForceUpdate').addEventListener('click', async () => {
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) await r.unregister();
        }
        if ('caches' in window) {
            const keys = await caches.keys();
            for (const k of keys) await caches.delete(k);
        }
    } catch (e) {}
    location.reload();
});

// --- INSTALAR COMO APP (banner propio, no depende del aviso automático de Chrome) ---
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!localStorage.getItem('installDismissed')) installBanner.classList.remove('hide');
});
btnInstallApp.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    installBanner.classList.add('hide');
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
});
btnDismissInstall.addEventListener('click', () => {
    installBanner.classList.add('hide');
    localStorage.setItem('installDismissed', '1');
});
window.addEventListener('appinstalled', () => {
    installBanner.classList.add('hide');
    deferredInstallPrompt = null;
});

// --- NETWORK & SYNC ---
async function validarPinRequest(pin, isSilent = false) {
    if (!isSilent) { btnLogin.textContent = "Validando..."; btnLogin.disabled = true; }
    try {
        const res = await fetch(GAS_URL, { method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "sync", pin: pin }) });
        const result = await res.json();

        if (result.status === "success") {
            sessionPin = pin;
            localStorage.setItem('iubVaultPin', pin);

            if (result.modules && result.modules.length > 0 && typeof result.modules[0] === 'string') {
                throw new Error("Backend V1 detectado. Publica una 'Nueva Implementación' en Apps Script.");
            }

            mergeServerData(result.modules || [], result.records || []);
            loginScreen.classList.add('hide'); loginError.classList.add('hide');
            renderInicio();
            if (currentContext.tema) renderNotebookFeed();
            hideBanner();
        } else if (result.code === "INVALID_PIN") {
            if (!isSilent) {
                loginError.textContent = "PIN incorrecto.";
                loginError.classList.remove('hide');
                pinInput.value = "";
            } else {
                localStorage.removeItem('iubVaultPin');
                sessionPin = "";
                loginScreen.classList.remove('hide');
            }
        } else {
            const msg = result.message || "Error del servidor.";
            if (!isSilent) { loginError.textContent = msg; loginError.classList.remove('hide'); }
            else { showBanner("⚠️ " + msg, "warn"); }
        }
    } catch (e) {
        if (!isSilent) {
            loginError.textContent = "Error de red o URL incorrecta.";
            loginError.classList.remove('hide');
        } else {
            showBanner("📡 Sin conexión con el servidor. Trabajando con datos locales.", "warn");
        }
    } finally {
        if (!isSilent) { btnLogin.textContent = "Desbloquear Workspace"; btnLogin.disabled = false; }
    }
}

// Combina lo que llega del servidor con capturas locales que aún no terminan de sincronizar (_pending).
function mergeServerData(modules, records) {
    const pendingLocal = localData.records.filter(r => r._pending);
    localData.modules = modules;
    const serverIds = new Set(records.map(r => r.id));
    localData.records = records.concat(pendingLocal.filter(r => !serverIds.has(r.id)));
    saveLocalData();
}

btnLogin.addEventListener('click', () => { if (pinInput.value.length >= 4) validarPinRequest(pinInput.value.trim()); });
btnSync.addEventListener('click', async () => {
    if (!sessionPin || isProcessingQueue) return;
    syncIcon.classList.add('animate-spin');
    await processQueue();
    await validarPinRequest(sessionPin, true);
    syncIcon.classList.remove('animate-spin');
});

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    try {
        let queue = await getQueue();
        while (queue.length > 0) {
            updateQueueBadge();
            const payload = queue[0];
            try {
                if (payload.blobFile) {
                    payload.imagenBase64 = await blobToBase64(payload.blobFile);
                    delete payload.blobFile;
                }
                const res = await fetch(GAS_URL, { method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
                const result = await res.json();

                if (result.status === "success") {
                    applyQueueSuccess(payload, result);
                    await removeFromQueue(payload.tempId);
                } else if (result.code === "INVALID_PIN") {
                    showBanner("⚠️ Tu PIN cambió o ya no es válido. Vuelve a iniciar sesión para sincronizar.", "warn", true);
                    break;
                } else {
                    showBanner("⚠️ No se pudo sincronizar: " + (result.message || "error del servidor"), "warn");
                    break;
                }
            } catch (e) { break; } // Offline, pausa segura
            queue = await getQueue();
        }
    } finally { isProcessingQueue = false; updateQueueBadge(); }
}

function applyQueueSuccess(payload, result) {
    if (payload.action === "save") {
        let rec = localData.records.find(r => r.id === payload.idRegistro);
        if (rec) {
            if (result.url) rec.url = result.url;
            if (result.fileId) rec.fileId = result.fileId;
            if (result.fecha) rec.fecha = result.fecha;
            delete rec._pending;
        } else {
            localData.records.unshift({
                id: result.id, fecha: result.fecha, cuatrimestre: payload.cuatrimestre, materia: payload.materia,
                tema: payload.tema, etiquetas: payload.etiquetas, tipo: payload.tipo, url: result.url,
                fileId: result.fileId || "", nota: payload.textoNota, comentarios: []
            });
        }
        saveLocalData();
        renderNotebookFeedIfActive();
        renderInicio();
    } else if (payload.action === "add_comment") {
        const rec = localData.records.find(r => r.id === payload.idRegistro);
        if (rec) {
            if (!rec.comentarios) rec.comentarios = [];
            if (payload.localCommentId) rec.comentarios = rec.comentarios.filter(c => c.id !== payload.localCommentId);
            const already = rec.comentarios.some(c => c.id === result.id);
            if (!already) rec.comentarios.push({ id: result.id, fecha: result.fecha, texto: result.texto });
            saveLocalData();
            if (currentRecordId === rec.id) renderModalComments(rec);
            renderNotebookFeedIfActive();
        }
    }
    // "delete" y "delete_comment" ya se reflejaron de forma optimista al momento del clic.
}

async function updateQueueBadge() {
    const q = await getQueue();
    if (q.length > 0) { queueBadge.textContent = q.length; queueBadge.classList.remove('hidden'); }
    else queueBadge.classList.add('hidden');
}

// --- NAVEGACIÓN: INICIO (cuatrimestre -> materias) ---
function switchTab(tabId, title, btnEl) {
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    el(tabId).classList.add('active');
    headerTitle.textContent = title;
    btnBackToInicio.classList.add('hide');
    btnExportPDF.classList.add('hide');
    captureBar.classList.add('hide');
    closeComposer();
    bottomNav.classList.remove('hide');
    document.querySelectorAll('.nav-btn').forEach(btn => { btn.classList.remove('text-gray-900', 'active-nav'); btn.classList.add('text-gray-400'); });
    if (btnEl) { btnEl.classList.remove('text-gray-400'); btnEl.classList.add('text-gray-900', 'active-nav'); }
    currentContext = { cuatrimestre: null, materia: null, tema: null };
    if (tabId === 'tabInicio') { searchInput.value = ""; renderInicio(); }
}
btnBackToInicio.addEventListener('click', () => switchTab('tabInicio', 'Mis Apuntes', document.querySelector('.nav-btn')));

function renderInicio() {
    const term = searchInput.value.toLowerCase().trim();
    if (term) {
        cuatriChips.classList.add('hide'); materiaGrid.classList.add('hide');
        searchResults.classList.remove('hide');
        renderSearchResults(term);
        return;
    }
    cuatriChips.classList.remove('hide'); materiaGrid.classList.remove('hide'); searchResults.classList.add('hide');

    const cuatris = [...new Set(localData.modules.map(m => m.cuatrimestre))]
        .sort((a, b) => String(b).localeCompare(String(a), undefined, { numeric: true }));

    if (!selectedCuatri || !cuatris.includes(selectedCuatri)) selectedCuatri = cuatris[0];

    cuatriChips.innerHTML = '';
    cuatris.forEach(c => {
        const chip = document.createElement('button');
        chip.className = 'chip' + (c === selectedCuatri ? ' active' : '');
        chip.textContent = 'Cuatrimestre ' + c;
        chip.onclick = () => { selectedCuatri = c; renderInicio(); };
        cuatriChips.appendChild(chip);
    });

    const materiasDelCuatri = [...new Set(localData.modules.filter(m => m.cuatrimestre === selectedCuatri).map(m => m.materia))];
    materiaGrid.innerHTML = '';
    materiasDelCuatri.forEach(materia => {
        const count = localData.records.filter(r => r.materia === materia).length;
        const card = document.createElement('div');
        card.className = "bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-col gap-2 active:scale-95 transition-transform cursor-pointer";
        card.innerHTML = `<span class="text-2xl">📔</span><p class="font-bold text-gray-800 text-sm leading-tight">${esc(materia)}</p><p class="text-[10px] text-gray-400 uppercase font-bold">${count} páginas</p>`;
        card.onclick = () => openMateria(materia);
        materiaGrid.appendChild(card);
    });
    const addCard = document.createElement('div');
    addCard.className = "border-2 border-dashed border-gray-200 rounded-2xl p-4 flex flex-col items-center justify-center gap-1 text-gray-400 active:scale-95 transition-transform cursor-pointer";
    addCard.innerHTML = `<span class="text-2xl">+</span><p class="text-xs font-bold text-center">Nueva Materia</p>`;
    addCard.onclick = () => switchTab('tabAjustes', 'Configuración', document.querySelectorAll('.nav-btn')[1]);
    materiaGrid.appendChild(addCard);
}
searchInput.addEventListener('input', renderInicio);

function renderSearchResults(term) {
    searchResults.innerHTML = '';
    const grouped = {};
    localData.modules.forEach(m => { if (!grouped[m.materia]) grouped[m.materia] = []; grouped[m.materia].push(m.tema); });
    for (const [materia, temas] of Object.entries(grouped)) {
        const materiaMatches = materia.toLowerCase().includes(term);
        const matchingTemas = temas.filter(t => t.toLowerCase().includes(term) ||
            localData.records.some(r => r.materia === materia && r.tema === t && r.etiquetas && r.etiquetas.toLowerCase().includes(term)));
        if (!materiaMatches && matchingTemas.length === 0) continue;

        const box = document.createElement('div');
        box.className = "bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden";
        box.innerHTML = `<div class="bg-gray-50 px-4 py-3 border-b border-gray-100 font-bold text-gray-800 text-sm">📚 ${esc(materia)}</div>`;
        const temasToShow = materiaMatches ? temas : matchingTemas;
        temasToShow.forEach(t => {
            const item = document.createElement('div');
            item.className = "px-4 py-3 flex justify-between items-center border-b border-gray-50 active:bg-gray-50 cursor-pointer";
            item.innerHTML = `<span class="text-sm font-semibold text-gray-700">📁 ${esc(t)}</span><span class="text-gray-300">›</span>`;
            item.onclick = () => { searchInput.value = ''; openMateria(materia); openTema(materia, t); };
            box.appendChild(item);
        });
        searchResults.appendChild(box);
    }
    if (!searchResults.innerHTML) searchResults.innerHTML = '<p class="text-center text-gray-400 text-sm py-10">Sin resultados.</p>';
}

// --- NAVEGACIÓN: CUADERNO DE UNA MATERIA ---
function openMateria(materia) {
    const temas = localData.modules.filter(m => m.materia === materia).map(m => m.tema);
    const lastTema = localStorage.getItem('lastTema_' + materia);
    const defaultTema = (lastTema && temas.includes(lastTema)) ? lastTema : temas[0];

    headerTitle.textContent = materia;
    btnBackToInicio.classList.remove('hide');
    btnExportPDF.classList.remove('hide');
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    el('tabMateria').classList.add('active');
    captureBar.classList.remove('hide');
    bottomNav.classList.add('hide');

    renderTemaChips(materia);
    if (defaultTema) openTema(materia, defaultTema);
    else notebookFeed.innerHTML = '<p class="col-span-2 text-center text-gray-400 text-sm py-10">Crea un tema para empezar a capturar.</p>';
}

function renderTemaChips(materia) {
    const temas = localData.modules.filter(m => m.materia === materia).map(m => m.tema);
    temaChips.innerHTML = '';
    temas.forEach(t => {
        const chip = document.createElement('button');
        chip.className = 'chip' + (t === currentContext.tema ? ' active' : '');
        chip.textContent = t;
        chip.onclick = () => openTema(materia, t);
        temaChips.appendChild(chip);
    });
    const addChip = document.createElement('button');
    addChip.className = 'chip';
    addChip.textContent = '+ Tema';
    addChip.onclick = () => quickAddTema(materia);
    temaChips.appendChild(addChip);
}

function openTema(materia, tema) {
    const mod = localData.modules.find(m => m.materia === materia && m.tema === tema);
    currentContext = { cuatrimestre: mod ? mod.cuatrimestre : "General", materia, tema };
    localStorage.setItem('lastTema_' + materia, tema);
    renderTemaChips(materia);
    renderNotebookFeed();
}

async function quickAddTema(materia) {
    const tema = prompt('Nombre del nuevo tema/corte para "' + materia + '":');
    if (!tema || !tema.trim()) return;
    if (!navigator.onLine) { showBanner("⚠️ Necesitas conexión para crear un tema nuevo.", "warn"); return; }
    const cuatri = (localData.modules.find(m => m.materia === materia) || {}).cuatrimestre || "General";
    try {
        const res = await fetch(GAS_URL, { method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "add_module", pin: sessionPin, cuatrimestre: cuatri, materia, tema: tema.trim() }) });
        const result = await res.json();
        if (result.status === "success") {
            localData.modules.push(result.newModule); saveLocalData();
            renderTemaChips(materia);
            openTema(materia, result.newModule.tema);
        } else showBanner("⚠️ " + (result.message || "No se pudo crear el tema."), "warn");
    } catch (e) { showBanner("⚠️ Sin conexión con el servidor.", "warn"); }
}

function formatFechaLarga(fechaStr) {
    const soloFecha = (fechaStr || "").split(' ')[0];
    const [y, m, d] = soloFecha.split('-').map(Number);
    if (!y) return soloFecha;
    const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    return `${d} de ${meses[m - 1]} de ${y}`;
}

function renderNotebookFeedIfActive() {
    if (el('tabMateria').classList.contains('active')) renderNotebookFeed();
}

function renderNotebookFeed() {
    const { materia, tema } = currentContext;
    notebookFeed.innerHTML = '';
    if (!materia || !tema) return;

    const records = localData.records
        .filter(r => r.materia === materia && r.tema === tema)
        .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

    if (records.length === 0) {
        notebookFeed.innerHTML = `<p class="col-span-2 text-center text-gray-400 text-sm py-10">Aún no hay páginas en este cuaderno.<br>Usa los botones de abajo para empezar.</p>`;
        return;
    }

    let lastDay = null;
    records.forEach(r => {
        const day = (r.fecha || "").split(' ')[0];
        if (day !== lastDay) {
            lastDay = day;
            const header = document.createElement('div');
            header.className = "col-span-2 pt-3 pb-1 first:pt-0";
            header.innerHTML = `<p class="text-[11px] font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100 pb-1">🗓️ ${esc(formatFechaLarga(r.fecha))}</p>`;
            notebookFeed.appendChild(header);
        }

        const div = document.createElement('div');
        div.className = "aspect-[3/4] bg-gray-100 rounded-xl overflow-hidden shadow-sm relative active:scale-95 transition-transform" + (r._pending ? " opacity-70" : "");
        const commentCount = (r.comentarios || []).length;
        if (r.url) {
            div.innerHTML = `<img src="${esc(r.url)}" class="w-full h-full object-cover" loading="lazy">
            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6"><p class="text-white text-[9px] font-bold tracking-wider">${esc((r.fecha || '').split(' ')[1] || '')}</p></div>`;
            if (r.etiquetas) div.innerHTML += `<span class="absolute top-2 right-2 bg-blue-500 text-white text-[8px] px-1.5 py-0.5 rounded font-bold">${esc(r.etiquetas.split(',')[0])}</span>`;
        } else {
            div.innerHTML = `<div class="w-full h-full p-3 text-xs text-gray-600 font-medium overflow-hidden bg-white border border-gray-200">${esc(r.nota)}</div>`;
        }
        if (r._pending) div.innerHTML += `<span class="absolute top-2 left-2 bg-gray-900/80 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold">⏳ subiendo</span>`;
        else if (commentCount > 0) div.innerHTML += `<span class="absolute top-2 left-2 bg-gray-900/80 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold">💬 ${commentCount}</span>`;
        div.onclick = () => showModal(r, records);
        notebookFeed.appendChild(div);
    });
}

// --- CAPTURA UNIFICADA (foto / galería / S-Pen / texto rápido) ---
async function commitPhotoRecord(blob, tipo, offerComposer) {
    const ctx = currentContext;
    if (!ctx.materia || !ctx.tema) { alert("⚠️ Entra a una materia y un tema primero."); return null; }

    const clientId = makeId();
    const localUrl = URL.createObjectURL(blob);
    const record = {
        id: clientId, fecha: localNow(), cuatrimestre: ctx.cuatrimestre, materia: ctx.materia, tema: ctx.tema,
        etiquetas: "", tipo, url: localUrl, fileId: "", nota: "", comentarios: [], _pending: true
    };
    localData.records.unshift(record);
    saveLocalData();
    renderNotebookFeedIfActive();

    await addToQueue({ action: "save", pin: sessionPin, idRegistro: clientId, cuatrimestre: ctx.cuatrimestre, materia: ctx.materia, tema: ctx.tema, etiquetas: "", tipo, textoNota: "", blobFile: blob });
    updateQueueBadge(); processQueue();

    if (offerComposer) openComposer('comment', clientId);
    return clientId;
}

async function commitTextRecord(texto) {
    const ctx = currentContext;
    if (!ctx.materia || !ctx.tema) { alert("⚠️ Entra a una materia y un tema primero."); return null; }

    const clientId = makeId();
    const record = { id: clientId, fecha: localNow(), cuatrimestre: ctx.cuatrimestre, materia: ctx.materia, tema: ctx.tema, etiquetas: "", tipo: "TEXTO", url: "", fileId: "", nota: texto, comentarios: [] };
    localData.records.unshift(record);
    saveLocalData();
    renderNotebookFeedIfActive();

    await addToQueue({ action: "save", pin: sessionPin, idRegistro: clientId, cuatrimestre: ctx.cuatrimestre, materia: ctx.materia, tema: ctx.tema, etiquetas: "", tipo: "TEXTO", textoNota: texto });
    updateQueueBadge(); processQueue();
    return clientId;
}

galleryInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    if (!currentContext.materia || !currentContext.tema) { alert("⚠️ Entra a una materia y un tema primero."); return; }
    if (files.length === 1) {
        await openAnnotateWithImage(files[0]);
    } else {
        for (const file of files) {
            const blob = await compressFileToBlob(file);
            await commitPhotoRecord(blob, "ARCHIVO", false);
        }
    }
});
cameraInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    if (!currentContext.materia || !currentContext.tema) { alert("⚠️ Entra a una materia y un tema primero."); return; }
    await openAnnotateWithImage(files[0]);
});

el('btnQuickText').addEventListener('click', () => {
    if (!currentContext.materia || !currentContext.tema) { alert("⚠️ Entra a una materia y un tema primero."); return; }
    openComposer('text', null);
});

// --- BARRA DE COMENTARIO / TEXTO RÁPIDO (composerStrip) ---
function openComposer(mode, recordId) {
    composerMode = mode; composerRecordId = recordId;
    composerInput.value = "";
    composerInput.placeholder = mode === 'text' ? "Escribe tu nota..." : "Comentario para esta captura (opcional)...";
    composerStrip.classList.remove('hide');
    composerInput.focus();
}
function closeComposer() {
    composerStrip.classList.add('hide');
    composerMode = null; composerRecordId = null;
}
btnComposerDismiss.addEventListener('click', closeComposer);
btnComposerSend.addEventListener('click', async () => {
    const texto = composerInput.value.trim();
    if (!texto) { closeComposer(); return; }
    if (composerMode === 'comment' && composerRecordId) {
        await addComentarioARegistro(composerRecordId, texto);
    } else if (composerMode === 'text') {
        await commitTextRecord(texto);
    }
    closeComposer();
});
composerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnComposerSend.click(); });

async function addComentarioARegistro(idRegistro, texto) {
    const record = localData.records.find(r => r.id === idRegistro);
    if (!record) return;
    if (!record.comentarios) record.comentarios = [];
    const tempId = 'local_' + Date.now();
    record.comentarios.push({ id: tempId, fecha: localNow(), texto });
    saveLocalData();
    renderNotebookFeedIfActive();
    if (currentRecordId === idRegistro) renderModalComments(record);

    await addToQueue({ action: "add_comment", pin: sessionPin, idRegistro, texto, localCommentId: tempId });
    updateQueueBadge(); processQueue();
}

// --- MOTOR S-PEN V2 (120HZ ALTA PRECISIÓN Y AUTO-COMMIT) ---
const canvasOverlay = el('drawingOverlay'), canvas = el('canvasNote'), ctx = canvas.getContext('2d', { desynchronized: true });
const bgRow = el('bgRow');
let isDrawing = false, lastMid = null, currentColor = '#000000', currentBg = 'bg-white';
let canvasBackgroundImage = null; // foto sobre la que se está anotando con el S-Pen (o null = hoja en blanco)

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight - 100; clearCanvasUI(); }
function clearCanvasUI() {
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (canvasBackgroundImage) {
        const img = canvasBackgroundImage;
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        return;
    }
    if (currentBg === 'bg-lines') {
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
        for (let i = 24; i < canvas.height; i += 24) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); }
    } else if (currentBg === 'bg-grid') {
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
        for (let i = 24; i < canvas.height; i += 24) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); }
        for (let j = 24; j < canvas.width; j += 24) { ctx.beginPath(); ctx.moveTo(j, 0); ctx.lineTo(j, canvas.height); ctx.stroke(); }
    }
}

// Abre el lienzo con la foto ya cargada de fondo para poder escribir/dibujar encima con el S-Pen.
async function openAnnotateWithImage(file) {
    const blob = await compressFileToBlob(file);
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = objectUrl; });
    canvasBackgroundImage = img;
    bgRow.classList.add('hide');
    resizeCanvas();
    canvasOverlay.classList.remove('hide');
}

el('btnOpenNotebook').addEventListener('click', () => {
    if (!currentContext.materia || !currentContext.tema) { alert("⚠️ Entra a una materia y un tema primero."); return; }
    canvasBackgroundImage = null;
    bgRow.classList.remove('hide');
    resizeCanvas(); canvasOverlay.classList.remove('hide');
});
el('btnCerrarCanvas').addEventListener('click', () => { canvasOverlay.classList.add('hide'); canvasBackgroundImage = null; });
el('btnBorrarLienzo').addEventListener('click', clearCanvasUI);

window.addEventListener('resize', () => { if (!canvasOverlay.classList.contains('hide')) resizeCanvas(); });

document.querySelectorAll('.tool-color').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tool-color').forEach(b => b.classList.remove('ring-2', 'ring-gray-900', 'active-tool'));
        e.target.classList.add('ring-2', 'ring-gray-900', 'active-tool'); currentColor = e.target.dataset.color;
    });
});
document.querySelectorAll('.tool-bg').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tool-bg').forEach(b => { b.classList.remove('bg-gray-600', 'active-bg'); b.classList.add('bg-gray-700'); });
        e.target.classList.remove('bg-gray-700'); e.target.classList.add('bg-gray-600', 'active-bg');
        currentBg = e.target.dataset.bg; clearCanvasUI();
    });
});

canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return; // Palm Rejection
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    lastMid = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    ctx.lineWidth = e.pressure ? e.pressure * 5 + 1 : 2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = currentColor;

    ctx.beginPath(); ctx.moveTo(lastMid.x, lastMid.y); ctx.lineTo(lastMid.x, lastMid.y); ctx.stroke();
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || (e.pointerType !== 'pen' && e.pointerType !== 'mouse')) return;

    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const rect = canvas.getBoundingClientRect();

    for (let ev of events) {
        const current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const mid = { x: (lastMid.x + current.x) / 2, y: (lastMid.y + current.y) / 2 };

        ctx.lineWidth = ev.pressure ? ev.pressure * 5 + 1 : 2;
        ctx.beginPath();
        ctx.moveTo(lastMid.x, lastMid.y);
        ctx.quadraticCurveTo(lastMid.x, lastMid.y, mid.x, mid.y);
        ctx.stroke();

        lastMid = current;
    }
});
canvas.addEventListener('pointerup', (e) => { if (e.pointerType === 'pen' || e.pointerType === 'mouse') isDrawing = false; });

el('btnGuardarCanvas').addEventListener('click', () => {
    const tipo = canvasBackgroundImage ? "ARCHIVO" : "NOTA_SPEN";
    canvas.toBlob(async (blob) => {
        canvasOverlay.classList.add('hide');
        canvasBackgroundImage = null;
        await commitPhotoRecord(blob, tipo, true);
    }, 'image/jpeg', 0.9);
});

// --- CRUD & VISOR ---
const imageModal = el('imageModal'), fullImage = el('fullImage'), modalDate = el('modalDate'), modalTags = el('modalTags'), modalNote = el('modalNote'), modalComments = el('modalComments'), comentarioInput = el('comentarioInput');

function showModal(record, list) {
    currentRecordId = record.id;
    modalContext.list = list || [record];
    modalContext.index = modalContext.list.findIndex(r => r.id === record.id);

    modalDate.textContent = formatFechaLarga(record.fecha) + ' · ' + (record.fecha.split(' ')[1] || '');
    modalTags.textContent = record.etiquetas ? `#${record.etiquetas.replace(/,/g, ' #')}` : '';
    fullImage.src = record.url || ""; fullImage.style.display = record.url ? "block" : "none";
    modalNote.textContent = record.nota || "Sin texto asociado.";
    el('btnDownload').style.display = record.url ? "flex" : "none"; el('btnShare').style.display = record.url ? "flex" : "none";
    renderModalComments(record);
    imageModal.classList.remove('hide');
}
el('btnCloseModal').addEventListener('click', () => imageModal.classList.add('hide'));

function renderModalComments(record) {
    modalComments.innerHTML = '';
    const comentarios = (record.comentarios || []).slice().sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    if (comentarios.length === 0) {
        modalComments.innerHTML = `<p class="text-gray-500 text-xs italic">Sin comentarios todavía. Agrega el primero abajo.</p>`;
        return;
    }
    comentarios.forEach(c => {
        const item = document.createElement('div');
        item.className = "bg-gray-800 rounded-xl p-3 flex justify-between items-start gap-2";
        item.innerHTML = `<div><p class="text-gray-200 text-sm">${esc(c.texto)}</p><p class="text-gray-500 text-[10px] mt-1 font-semibold">${esc(c.fecha)}</p></div>
        <button class="text-gray-500 hover:text-red-400 text-xs shrink-0" title="Eliminar comentario">✕</button>`;
        item.querySelector('button').addEventListener('click', () => deleteComentario(record, c.id));
        modalComments.appendChild(item);
    });
}

async function deleteComentario(record, comentarioId) {
    if (!confirm("¿Eliminar este comentario?")) return;
    record.comentarios = (record.comentarios || []).filter(c => c.id !== comentarioId);
    saveLocalData();
    renderModalComments(record);
    renderNotebookFeedIfActive();
    if (!comentarioId.toString().startsWith('local_')) {
        await addToQueue({ action: "delete_comment", pin: sessionPin, idComentario: comentarioId });
        updateQueueBadge(); processQueue();
    }
}

el('btnAddComentario').addEventListener('click', async () => {
    const texto = comentarioInput.value.trim();
    if (!texto || !currentRecordId) return;
    comentarioInput.value = "";
    await addComentarioARegistro(currentRecordId, texto);
});
comentarioInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btnAddComentario').click(); });

function swapRecords(dir) {
    const target = modalContext.index + dir;
    if (target < 0 || target >= modalContext.list.length) return;
    modalContext.index = target;
    showModal(modalContext.list[target], modalContext.list);
}
el('btnMoveLeft').addEventListener('click', () => swapRecords(-1)); el('btnMoveRight').addEventListener('click', () => swapRecords(1));

el('btnDelete').addEventListener('click', async () => {
    if (!confirm("¿Eliminar archivo permanentemente?")) return;
    const rec = localData.records.find(r => r.id === currentRecordId);
    if (!rec) return;
    const fileId = rec.fileId || (rec.url && rec.url.includes('/d/') ? rec.url.split('/d/')[1] : null);

    localData.records = localData.records.filter(r => r.id !== currentRecordId);
    saveLocalData();
    imageModal.classList.add('hide');
    renderNotebookFeedIfActive();
    renderInicio();

    await addToQueue({ action: "delete", pin: sessionPin, idRegistro: currentRecordId, fileId: fileId });
    updateQueueBadge(); processQueue();
});

el('btnShare').addEventListener('click', async () => {
    const r = localData.records.find(x => x.id === currentRecordId);
    if (r && navigator.share) navigator.share({ title: r.tema, text: r.nota, url: r.url }).catch(() => {});
});
el('btnDownload').addEventListener('click', () => {
    const r = localData.records.find(x => x.id === currentRecordId);
    if (r && r.url) window.open(r.url, '_blank');
});

// --- AJUSTES ---
el('btnAgregarEstructura').addEventListener('click', async () => {
    const q = el('nuevoCuatrimestre').value, m = el('nuevaMateria').value.trim(), t = el('nuevoTema').value.trim();
    if (!q || !m || !t) return;
    const statusEl = el('ajustesStatus');
    statusEl.textContent = "Creando..."; statusEl.classList.remove('hidden'); el('btnAgregarEstructura').disabled = true;
    if (!navigator.onLine) {
        statusEl.textContent = "⚠️ Necesitas conexión para crear una materia nueva.";
        el('btnAgregarEstructura').disabled = false;
        return;
    }
    try {
        const res = await fetch(GAS_URL, { method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "add_module", pin: sessionPin, cuatrimestre: q, materia: m, tema: t }) });
        const result = await res.json();
        if (result.status === "success") {
            localData.modules.push(result.newModule); saveLocalData();
            statusEl.textContent = "✅ Creado";
            el('nuevaMateria').value = ""; el('nuevoTema').value = ""; setTimeout(() => statusEl.classList.add('hidden'), 2000);
        } else {
            statusEl.textContent = "⚠️ " + (result.message || "No se pudo crear.");
        }
    } catch (e) {
        statusEl.textContent = "⚠️ Sin conexión con el servidor.";
    } finally { el('btnAgregarEstructura').disabled = false; }
});
el('btnLimpiarCache').addEventListener('click', () => {
    if (!confirm("Esto borrará la sesión y los datos guardados en este dispositivo. ¿Continuar?")) return;
    localStorage.clear(); location.reload();
});

// --- EXPORTACIÓN PDF PROFESIONAL (JSPDF) ---
btnExportPDF.addEventListener('click', async () => {
    if (!currentContext.tema) return;
    const { jsPDF } = window.jspdf; const doc = new jsPDF('p', 'mm', 'a4');
    const records = localData.records
        .filter(r => r.materia === currentContext.materia && r.tema === currentContext.tema)
        .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    if (records.length === 0) return alert("No hay páginas para exportar.");

    btnExportPDF.textContent = "⏳";
    doc.setFontSize(22); doc.text(currentContext.materia, 10, 20);
    doc.setFontSize(14); doc.text(`Tema: ${currentContext.tema}`, 10, 30);
    doc.setFontSize(10); doc.text(`Generado: ${new Date().toLocaleDateString()}`, 10, 40);

    let first = true;
    for (const rec of records) {
        if (!first) doc.addPage();
        first = false;
        let yPos = 20;
        doc.setFontSize(10); doc.setTextColor(0); doc.text(rec.fecha || "", 10, yPos); yPos += 8;

        if (rec.url) {
            try {
                const img = new Image(); img.crossOrigin = "Anonymous"; img.src = rec.url;
                await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
                const canvasImg = document.createElement('canvas'); canvasImg.width = img.width; canvasImg.height = img.height;
                canvasImg.getContext('2d').drawImage(img, 0, 0);
                const dataUri = canvasImg.toDataURL('image/jpeg', 0.8);
                const imgProps = doc.getImageProperties(dataUri);
                const pdfWidth = doc.internal.pageSize.getWidth() - 20;
                const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
                doc.addImage(dataUri, 'JPEG', 10, yPos, pdfWidth, pdfHeight);
                yPos += pdfHeight + 8;
            } catch (e) { console.error("Saltando imagen inaccesible por CORS"); }
        }

        if (rec.nota) { doc.setFontSize(11); doc.text(doc.splitTextToSize("Nota: " + rec.nota, 190), 10, yPos); yPos += doc.splitTextToSize(rec.nota, 190).length * 6 + 4; }

        (rec.comentarios || []).forEach(c => {
            const lines = doc.splitTextToSize(`[${c.fecha}] ${c.texto}`, 185);
            if (yPos + lines.length * 5 > 280) { doc.addPage(); yPos = 20; }
            doc.setFontSize(9); doc.setTextColor(90);
            doc.text(lines, 15, yPos);
            yPos += lines.length * 5 + 2;
            doc.setTextColor(0);
        });
    }
    doc.save(`Apuntes_${currentContext.materia}_${currentContext.tema}.pdf`);
    btnExportPDF.textContent = "📑";
});

initApp();
