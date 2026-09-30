// CONFIGURACIÓN OBLIGATORIA
const GAS_URL = "https://script.google.com/macros/s/AKfycbyPIv-c9UqYflEdfiX1aCoCSHnNOz0qCGcXRkH8wxaRZd-c4bHYPOh0qbfkSJ5-Oij-/exec";
const APP_VERSION = "2026.09.27-2-sin-sw"; // se muestra en Ajustes para confirmar qué versión cargó tu celular

// --- INDEXEDDB V2 (SOPORTE DE BLOBS SEGURO) ---
const DB_NAME = 'IUBVaultDB_v2';
const DB_VERSION = 2; // v2: agrega el store "documents" (borradores del lienzo S-Pen con strokes)
const STORE_NAME = 'uploadQueue';
const DOCS_STORE_NAME = 'documents';

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'tempId' });
        if (!db.objectStoreNames.contains(DOCS_STORE_NAME)) db.createObjectStore(DOCS_STORE_NAME, { keyPath: 'localId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

// --- PERSISTENCIA DE BORRADORES (documento con strokes, sobrevive a cerrar la PWA) ---
async function saveDraft(docObj) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DOCS_STORE_NAME, 'readwrite');
        tx.objectStore(DOCS_STORE_NAME).put(docObj);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
async function deleteDraft(localId) {
    const db = await dbPromise;
    return new Promise((resolve) => {
        const tx = db.transaction(DOCS_STORE_NAME, 'readwrite');
        tx.objectStore(DOCS_STORE_NAME).delete(localId);
        tx.oncomplete = () => resolve();
    });
}
async function getAllDrafts() {
    const db = await dbPromise;
    return new Promise((resolve) => {
        const request = db.transaction(DOCS_STORE_NAME, 'readonly').objectStore(DOCS_STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
    });
}

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
const PHOTO_MAX_WIDTH = 2200; // antes 1920: más legible para letra pequeña de pizarra/fórmulas

// Comprime y corrige la orientación EXIF (evita fotos que se ven rotadas 90°/180°).
async function compressFileToBlob(file) {
    if (window.createImageBitmap) {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
            const blob = await bitmapToBlob(bitmap);
            bitmap.close();
            return blob;
        } catch (e) { /* algunos navegadores no soportan la opción; usar fallback */ }
    }
    return compressFileToBlobFallback(file);
}
function bitmapToBlob(bitmap) {
    const canvas = document.createElement('canvas');
    let width = bitmap.width, height = bitmap.height;
    if (width > PHOTO_MAX_WIDTH) { height = Math.round(height * PHOTO_MAX_WIDTH / width); width = PHOTO_MAX_WIDTH; }
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}
function compressFileToBlobFallback(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width, height = img.height;
                if (width > PHOTO_MAX_WIDTH) { height = Math.round(height * PHOTO_MAX_WIDTH / width); width = PHOTO_MAX_WIDTH; }
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
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

    renderThicknessRow();
    updateToolButtons();
    if (sessionPin) checkForDrafts();

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

// ============================================================================
// MOTOR S-PEN V3: documento multicapa (background + ink) con coordenadas de
// documento independientes del viewport, zoom/pan real, undo/redo, borrador,
// grosor configurable y autoguardado a IndexedDB (recuperable si se cierra la PWA).
// ============================================================================
const canvasOverlay = el('drawingOverlay');
const canvasScrollArea = el('canvasScrollArea');
const canvasStack = el('canvasStack');
const bgCanvas = el('bgCanvas'), inkCanvas = el('inkCanvas');
const bgCtx = bgCanvas.getContext('2d');
const inkCtx = inkCanvas.getContext('2d', { desynchronized: true });
const bgRow = el('bgRow');
const toolPenBtn = el('toolPen'), toolEraserBtn = el('toolEraser');
const thicknessRow = el('thicknessRow');
const btnUndo = el('btnUndo'), btnRedo = el('btnRedo');
const togglePressureBtn = el('togglePressure');
const draftBanner = el('draftBanner'), draftBannerSub = el('draftBannerSub');
const btnResumeDraft = el('btnResumeDraft'), btnDiscardDraft = el('btnDiscardDraft');

const SHEET_HEIGHT_FACTOR = 2.5; // la hoja "documento" es 2.5x más alta que la pantalla al crearse
const THICKNESS_OPTIONS = [1, 2, 3, 4, 6, 8];
const CANVAS_DPR = Math.min(window.devicePixelRatio || 1, 2.5); // límite razonable: nítido sin canvas gigantes

let currentColor = '#000000';
let currentTool = 'pen'; // 'pen' | 'eraser'
let selectedWidth = 3;
let pressureEnabled = true;

// --- DOCUMENTO (fuente de verdad de la sesión de edición actual) ---
// doc.meta.docWidth/docHeight = tamaño FIJO en px CSS, definido una sola vez al crear
// el documento. NUNCA cambia por resize/rotación/zoom: así resize/orientación jamás
// pueden perder o deformar strokes ya dibujados.
let doc = null;
let redoStack = [];
let currentStroke = null;
let activePointerId = null;
let autosaveTimer = null;
let pendingBgBlob = null; // blob original de la foto (para subir sin recomprimir si no se anotó nada)

function newDoc(materiaTema, backgroundImg, backgroundBlob) {
    const viewW = window.innerWidth;
    const viewH = Math.round((canvasScrollArea.clientHeight || window.innerHeight) * SHEET_HEIGHT_FACTOR);
    return {
        localId: makeId(),
        materia: materiaTema.materia, tema: materiaTema.tema, cuatrimestre: materiaTema.cuatrimestre,
        background: backgroundImg ? { hasImage: true, naturalWidth: backgroundImg.width, naturalHeight: backgroundImg.height, blob: backgroundBlob } : { hasImage: false },
        strokes: [],
        text: [],      // reservado para una futura capa de texto sobre el lienzo (no usado todavía)
        comments: [],  // reservado (los comentarios reales viven en el registro, no en el borrador)
        meta: { docWidth: viewW, docHeight: viewH, bgPattern: 'bg-white', createdAt: Date.now(), updatedAt: Date.now() }
    };
}

// --- IndexedDB: autoguardado con debounce (nunca en cada pointermove) ---
function scheduleAutosave() {
    if (!doc) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 700);
}
async function autosaveNow() {
    if (!doc) return;
    doc.meta.updatedAt = Date.now();
    try { await saveDraft(doc); } catch (e) { /* almacenamiento lleno u otro fallo: no bloquea la escritura en curso */ }
}
async function loadBackgroundImageFromBlob(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = url; });
    return img;
}

// --- RENDER: reconstruible en cualquier momento desde el documento ---
function layoutCanvasStack() {
    const w = doc.meta.docWidth, h = doc.meta.docHeight;
    canvasStack.style.width = w + 'px';
    canvasStack.style.height = h + 'px';
    [bgCanvas, inkCanvas].forEach((c) => {
        c.style.width = w + 'px';
        c.style.height = h + 'px';
        c.width = Math.round(w * CANVAS_DPR);
        c.height = Math.round(h * CANVAS_DPR);
    });
    bgCtx.setTransform(CANVAS_DPR, 0, 0, CANVAS_DPR, 0, 0);
    inkCtx.setTransform(CANVAS_DPR, 0, 0, CANVAS_DPR, 0, 0);
}

let bgImageEl = null; // Image ya decodificada del fondo (si hay foto)

function renderBackground() {
    const w = doc.meta.docWidth, h = doc.meta.docHeight;
    bgCtx.clearRect(0, 0, w, h);
    bgCtx.fillStyle = "white"; bgCtx.fillRect(0, 0, w, h);

    if (doc.background.hasImage && bgImageEl) {
        const img = bgImageEl;
        const maxW = w * 0.9, maxH = h * 0.45;
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const iw = img.width * scale, ih = img.height * scale;
        const ix = (w - iw) / 2, iy = 20;
        bgCtx.drawImage(img, ix, iy, iw, ih);
        bgCtx.strokeStyle = '#e5e7eb'; bgCtx.lineWidth = 1;
        for (let i = iy + ih + 28; i < h; i += 32) { bgCtx.beginPath(); bgCtx.moveTo(16, i); bgCtx.lineTo(w - 16, i); bgCtx.stroke(); }
        return;
    }
    const pattern = doc.meta.bgPattern;
    if (pattern === 'bg-lines') {
        bgCtx.strokeStyle = '#e5e7eb'; bgCtx.lineWidth = 1;
        for (let i = 24; i < h; i += 24) { bgCtx.beginPath(); bgCtx.moveTo(0, i); bgCtx.lineTo(w, i); bgCtx.stroke(); }
    } else if (pattern === 'bg-grid') {
        bgCtx.strokeStyle = '#e5e7eb'; bgCtx.lineWidth = 1;
        for (let i = 24; i < h; i += 24) { bgCtx.beginPath(); bgCtx.moveTo(0, i); bgCtx.lineTo(w, i); bgCtx.stroke(); }
        for (let j = 24; j < w; j += 24) { bgCtx.beginPath(); bgCtx.moveTo(j, 0); bgCtx.lineTo(j, h); bgCtx.stroke(); }
    }
}

function widthForPoint(stroke, point) {
    if (stroke.tool === 'eraser') return stroke.width * 2.4;
    if (!stroke.pressureEnabled) return stroke.width;
    // pressureCurve: modulación suave (0.35x - 1.6x del grosor elegido), nunca depende SOLO de pressure*5+1
    const curved = Math.pow(point.p, 0.65); // curva suave: la presión baja no adelgaza demasiado
    return Math.max(0.6, stroke.width * (0.35 + curved * 1.25));
}

function drawStroke(context, stroke) {
    if (stroke.points.length === 0) return;
    context.save();
    context.lineCap = 'round'; context.lineJoin = 'round';
    if (stroke.tool === 'eraser') { context.globalCompositeOperation = 'destination-out'; context.strokeStyle = 'rgba(0,0,0,1)'; }
    else { context.globalCompositeOperation = 'source-over'; context.strokeStyle = stroke.color; }

    if (stroke.points.length === 1) {
        const p = stroke.points[0];
        context.fillStyle = context.strokeStyle;
        context.beginPath(); context.arc(p.x, p.y, widthForPoint(stroke, p) / 2, 0, Math.PI * 2); context.fill();
        context.restore();
        return;
    }
    for (let i = 1; i < stroke.points.length; i++) {
        const p0 = stroke.points[i - 1], p1 = stroke.points[i];
        const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        context.lineWidth = widthForPoint(stroke, p1);
        context.beginPath();
        context.moveTo(p0.x, p0.y);
        context.quadraticCurveTo(p0.x, p0.y, mid.x, mid.y);
        context.stroke();
    }
    context.restore();
}

// Reconstrucción TOTAL de la capa de tinta desde doc.strokes (undo/redo/carga de borrador).
function renderInk() {
    inkCtx.clearRect(0, 0, doc.meta.docWidth, doc.meta.docHeight);
    for (const s of doc.strokes) drawStroke(inkCtx, s);
}

function renderAll() { layoutCanvasStack(); renderBackground(); renderInk(); }

// --- COORDENADAS: única función central, sin duplicar cálculos en ningún otro lugar ---
// viewport (clientX/Y) -> boundingClientRect (ya refleja scroll/zoom/pan vía CSS transform)
// -> coordenadas de documento (independientes de DPR, zoom y resolución interna del canvas).
function getDocumentPoint(e) {
    const rect = inkCanvas.getBoundingClientRect();
    const scaleX = rect.width / doc.meta.docWidth;
    const scaleY = rect.height / doc.meta.docHeight;
    return {
        x: (e.clientX - rect.left) / scaleX,
        y: (e.clientY - rect.top) / scaleY,
        p: (e.pressure && e.pressure > 0) ? e.pressure : 0.5
    };
}

// --- CICLO DE VIDA DEL TRAZO ---
function startStroke(pt) {
    currentStroke = { id: makeId(), tool: currentTool, color: currentColor, width: selectedWidth, pressureEnabled, points: [pt] };
    drawStroke(inkCtx, currentStroke); // punto inicial visible de inmediato
}
function extendStroke(pt) {
    if (!currentStroke) return;
    const prevLen = currentStroke.points.length;
    currentStroke.points.push(pt);
    // Dibuja SOLO el segmento nuevo (incremental) — nunca se repinta todo en pointermove.
    drawStroke(inkCtx, { ...currentStroke, points: currentStroke.points.slice(Math.max(0, prevLen - 1)) });
}
function finishStroke() {
    if (!currentStroke) return;
    if (currentStroke.points.length > 0) {
        doc.strokes.push(currentStroke);
        redoStack = []; // una acción nueva invalida el historial de rehacer
        updateUndoRedoButtons();
        scheduleAutosave();
    }
    currentStroke = null;
}

// --- PUNTERO: pen/mouse escriben; touch nunca genera tinta (lo usa el zoom/pan) ---
inkCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
    if (activePointerId !== null) return; // ya hay un trazo en curso, ignora punteros extra
    activePointerId = e.pointerId;
    try { inkCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    startStroke(getDocumentPoint(e));
});
inkCanvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointerId) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) extendStroke(getDocumentPoint(ev));
});
function endActiveStroke(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    try { inkCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
    finishStroke();
}
inkCanvas.addEventListener('pointerup', endActiveStroke);
inkCanvas.addEventListener('pointercancel', endActiveStroke);
// lostpointercapture es la red de seguridad real (el sistema puede quitar la captura sin pointerup/cancel).
inkCanvas.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId === activePointerId) { activePointerId = null; finishStroke(); }
});

// --- ZOOM / PAN (solo dedo) — reutilizable: lienzo de escritura y visor de fotos ---
function createZoomPanController(container, target, opts) {
    const cfg = Object.assign({ minScale: 1, maxScale: 4, doubleTapScale: 2.5, panWhenUnzoomed: false, pointerFilter: null, getBounds: null, onChange: null }, opts || {});
    const state = { scale: 1, tx: 0, ty: 0 };
    const pointers = new Map();
    let pinchStartDist = 0, pinchStartScale = 1, pinchStartMid = null, pinchStartTx = 0, pinchStartTy = 0;
    let dragStart = null, dragStartTx = 0, dragStartTy = 0;
    let lastTap = 0;

    function apply() {
        target.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
        if (cfg.onChange) cfg.onChange(state);
    }
    function clampState() {
        state.scale = Math.min(cfg.maxScale, Math.max(cfg.minScale, state.scale));
        if (cfg.getBounds) {
            const b = cfg.getBounds(state.scale);
            state.tx = Math.min(b.maxTx, Math.max(b.minTx, state.tx));
            state.ty = Math.min(b.maxTy, Math.max(b.minTy, state.ty));
        }
    }
    function reset() { state.scale = 1; state.tx = 0; state.ty = 0; clampState(); apply(); }

    container.addEventListener('pointerdown', (e) => {
        if (cfg.pointerFilter && !cfg.pointerFilter(e)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { container.setPointerCapture(e.pointerId); } catch (err) {}
        if (pointers.size === 1) {
            dragStart = { x: e.clientX, y: e.clientY }; dragStartTx = state.tx; dragStartTy = state.ty;
            const now = Date.now();
            if (now - lastTap < 280) {
                state.scale = state.scale > 1.05 ? 1 : cfg.doubleTapScale;
                if (state.scale === 1) { state.tx = 0; state.ty = 0; }
                clampState(); apply();
            }
            lastTap = now;
        } else if (pointers.size === 2) {
            const pts = Array.from(pointers.values());
            pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
            pinchStartScale = state.scale;
            pinchStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            pinchStartTx = state.tx; pinchStartTy = state.ty;
        }
    });
    container.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
            const pts = Array.from(pointers.values());
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
            const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            state.scale = pinchStartScale * (dist / pinchStartDist);
            state.tx = pinchStartTx + (mid.x - pinchStartMid.x);
            state.ty = pinchStartTy + (mid.y - pinchStartMid.y);
            clampState(); apply();
        } else if (pointers.size === 1 && dragStart && (state.scale > 1.01 || cfg.panWhenUnzoomed)) {
            state.tx = dragStartTx + (e.clientX - dragStart.x);
            state.ty = dragStartTy + (e.clientY - dragStart.y);
            clampState(); apply();
        }
    });
    function endPointer(e) {
        pointers.delete(e.pointerId);
        try { container.releasePointerCapture(e.pointerId); } catch (err) {}
        if (pointers.size < 2) pinchStartDist = 0;
        if (pointers.size === 0) dragStart = null;
    }
    container.addEventListener('pointerup', endPointer);
    container.addEventListener('pointercancel', endPointer);
    container.addEventListener('lostpointercapture', endPointer);

    return { state, apply, clampState, reset };
}

const canvasZoomPan = createZoomPanController(canvasScrollArea, canvasStack, {
    minScale: 1, maxScale: 3, panWhenUnzoomed: true,
    pointerFilter: (e) => e.pointerType === 'touch',
    getBounds: (scale) => {
        const viewW = canvasScrollArea.clientWidth, viewH = canvasScrollArea.clientHeight;
        const contentW = doc.meta.docWidth * scale, contentH = doc.meta.docHeight * scale;
        return { minTx: Math.min(0, viewW - contentW), maxTx: 0, minTy: Math.min(0, viewH - contentH), maxTy: 0 };
    }
});

// --- HERRAMIENTAS: grosor, lápiz/borrador, presión, deshacer/rehacer ---
function renderThicknessRow() {
    thicknessRow.innerHTML = '';
    THICKNESS_OPTIONS.forEach((w) => {
        const btn = document.createElement('button');
        btn.className = 'w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center shrink-0' + (w === selectedWidth ? ' ring-2 ring-white' : '');
        const dot = document.createElement('span');
        const size = Math.min(w * 1.7, 18);
        dot.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:white;display:block;`;
        btn.appendChild(dot);
        btn.onclick = () => { selectedWidth = w; renderThicknessRow(); };
        thicknessRow.appendChild(btn);
    });
}
function updateToolButtons() {
    toolPenBtn.className = 'text-xs px-2.5 py-1.5 rounded-lg font-bold shrink-0 ' + (currentTool === 'pen' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300');
    toolEraserBtn.className = 'text-xs px-2.5 py-1.5 rounded-lg font-bold shrink-0 ' + (currentTool === 'eraser' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300');
}
toolPenBtn.addEventListener('click', () => { currentTool = 'pen'; updateToolButtons(); });
toolEraserBtn.addEventListener('click', () => { currentTool = 'eraser'; updateToolButtons(); });
togglePressureBtn.addEventListener('click', () => {
    pressureEnabled = !pressureEnabled;
    togglePressureBtn.textContent = 'Presión: ' + (pressureEnabled ? 'ON' : 'OFF');
});
function updateUndoRedoButtons() {
    btnUndo.disabled = !doc || doc.strokes.length === 0;
    btnRedo.disabled = redoStack.length === 0;
    btnUndo.classList.toggle('opacity-40', btnUndo.disabled);
    btnRedo.classList.toggle('opacity-40', btnRedo.disabled);
}
btnUndo.addEventListener('click', () => {
    if (!doc || doc.strokes.length === 0) return;
    redoStack.push(doc.strokes.pop());
    renderInk(); updateUndoRedoButtons(); scheduleAutosave();
});
btnRedo.addEventListener('click', () => {
    if (redoStack.length === 0) return;
    doc.strokes.push(redoStack.pop());
    renderInk(); updateUndoRedoButtons(); scheduleAutosave();
});

document.querySelectorAll('.tool-color').forEach((btn) => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tool-color').forEach((b) => b.classList.remove('ring-2', 'ring-gray-900', 'active-tool'));
        e.target.classList.add('ring-2', 'ring-gray-900', 'active-tool');
        currentColor = e.target.dataset.color;
        currentTool = 'pen'; updateToolButtons();
    });
});
document.querySelectorAll('.tool-bg').forEach((btn) => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tool-bg').forEach((b) => { b.classList.remove('bg-gray-600', 'active-bg'); b.classList.add('bg-gray-700'); });
        e.target.classList.remove('bg-gray-700'); e.target.classList.add('bg-gray-600', 'active-bg');
        doc.meta.bgPattern = e.target.dataset.bg;
        renderBackground(); scheduleAutosave();
    });
});

el('btnBorrarLienzo').addEventListener('click', () => {
    if (!doc || doc.strokes.length === 0) return;
    if (!confirm('¿Borrar todos los trazos de esta hoja? (la foto no se toca)')) return;
    redoStack = []; doc.strokes = [];
    renderInk(); updateUndoRedoButtons(); scheduleAutosave();
});

// --- ABRIR / CERRAR EL LIENZO ---
async function openCanvasWithDocument(newDocument, bgBlob) {
    doc = newDocument;
    pendingBgBlob = bgBlob || null;
    redoStack = []; currentStroke = null; activePointerId = null;
    bgImageEl = doc.background.hasImage ? await loadBackgroundImageFromBlob(doc.background.blob) : null;
    bgRow.classList.toggle('hide', doc.background.hasImage);
    document.querySelectorAll('.tool-bg').forEach((b) => {
        const active = b.dataset.bg === doc.meta.bgPattern;
        b.classList.toggle('active-bg', active);
        b.classList.toggle('bg-gray-600', active);
        b.classList.toggle('bg-gray-700', !active);
    });
    canvasZoomPan.reset();
    canvasOverlay.classList.remove('hide');
    renderAll();
    updateUndoRedoButtons();
    await saveDraft(doc); // existe en IndexedDB desde el primer instante, incluso sin trazos
}

async function openAnnotateWithImage(file) {
    const blob = await compressFileToBlob(file);
    const img = await loadBackgroundImageFromBlob(blob);
    const d = newDoc(currentContext, img, blob);
    await openCanvasWithDocument(d, blob);
}
el('btnOpenNotebook').addEventListener('click', async () => {
    if (!currentContext.materia || !currentContext.tema) { alert("⚠️ Entra a una materia y un tema primero."); return; }
    const d = newDoc(currentContext, null, null);
    await openCanvasWithDocument(d, null);
});
el('btnCerrarCanvas').addEventListener('click', () => {
    canvasOverlay.classList.add('hide');
    doc = null; bgImageEl = null; pendingBgBlob = null;
    hideDraftBanner();
});

window.addEventListener('resize', () => {
    // El documento NUNCA cambia de tamaño por resize/rotación: solo se re-emite el layout
    // visual (la hoja sigue siendo la misma; se ve completa o se navega con zoom/scroll).
    if (doc && !canvasOverlay.classList.contains('hide')) { layoutCanvasStack(); renderBackground(); renderInk(); }
});

el('btnGuardarCanvas').addEventListener('click', async () => {
    if (!doc) return;
    const tipo = doc.background.hasImage ? "ARCHIVO" : "NOTA_SPEN";
    const finishedDocId = doc.localId;
    canvasOverlay.classList.add('hide');

    let finalBlob;
    if (doc.background.hasImage && doc.strokes.length === 0 && pendingBgBlob) {
        // No se escribió nada encima: sube la foto original tal cual (sin recomprimir de nuevo).
        finalBlob = pendingBgBlob;
    } else {
        finalBlob = await composeFinalBlob();
    }
    doc = null; bgImageEl = null; pendingBgBlob = null;
    await commitPhotoRecord(finalBlob, tipo, true);
    await deleteDraft(finishedDocId); // ya pasó a la cola de subida (persistente); el borrador no hace más falta
    hideDraftBanner();
});

function composeFinalBlob() {
    const out = document.createElement('canvas');
    out.width = bgCanvas.width; out.height = bgCanvas.height;
    const octx = out.getContext('2d');
    octx.drawImage(bgCanvas, 0, 0);
    octx.drawImage(inkCanvas, 0, 0);
    return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.92));
}

// --- RECUPERACIÓN DE BORRADOR (sobrevive a cerrar la PWA) ---
function hideDraftBanner() { draftBanner.classList.add('hide'); }
async function checkForDrafts() {
    const drafts = await getAllDrafts();
    if (drafts.length === 0) return;
    const latest = drafts.sort((a, b) => (b.meta.updatedAt || 0) - (a.meta.updatedAt || 0))[0];
    draftBannerSub.textContent = `${latest.materia} · ${latest.tema} · ${latest.strokes.length} trazo(s)`;
    draftBanner.classList.remove('hide');
    btnResumeDraft.onclick = async () => {
        hideDraftBanner();
        openMateria(latest.materia);
        openTema(latest.materia, latest.tema);
        await openCanvasWithDocument(latest, latest.background.hasImage ? latest.background.blob : null);
    };
    btnDiscardDraft.onclick = async () => { await deleteDraft(latest.localId); hideDraftBanner(); };
}

// --- CRUD & VISOR ---
const imageModal = el('imageModal'), fullImage = el('fullImage'), modalDate = el('modalDate'), modalTags = el('modalTags'), modalNote = el('modalNote'), modalComments = el('modalComments'), comentarioInput = el('comentarioInput');
const imageViewerArea = el('imageViewerArea');

// Visor con pinch-zoom / doble-tap / pan (dedo únicamente): mismo controlador que el lienzo S-Pen.
const imageZoomPan = createZoomPanController(imageViewerArea, fullImage, {
    minScale: 1, maxScale: 4, doubleTapScale: 2.5, panWhenUnzoomed: false,
    pointerFilter: (e) => e.pointerType === 'touch' || e.pointerType === 'mouse'
});

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
    imageZoomPan.reset(); // cada foto nueva arranca sin zoom heredado de la anterior
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
    const { jsPDF } = window.jspdf; const pdf = new jsPDF('p', 'mm', 'a4');
    const records = localData.records
        .filter(r => r.materia === currentContext.materia && r.tema === currentContext.tema)
        .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    if (records.length === 0) return alert("No hay páginas para exportar.");

    const PAGE_W = pdf.internal.pageSize.getWidth(), PAGE_H = pdf.internal.pageSize.getHeight();
    const MARGIN = 10, MAX_Y = PAGE_H - MARGIN;

    btnExportPDF.textContent = "⏳";
    pdf.setFontSize(22); pdf.text(currentContext.materia, MARGIN, 20);
    pdf.setFontSize(14); pdf.text(`Tema: ${currentContext.tema}`, MARGIN, 30);
    pdf.setFontSize(10); pdf.text(`Generado: ${new Date().toLocaleDateString()}`, MARGIN, 40);

    let first = true;
    for (const rec of records) {
        if (!first) pdf.addPage();
        first = false;
        let yPos = 20;
        pdf.setFontSize(10); pdf.setTextColor(0); pdf.text(rec.fecha || "", MARGIN, yPos); yPos += 8;

        if (rec.url) {
            try {
                const img = new Image(); img.crossOrigin = "Anonymous"; img.src = rec.url;
                await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
                const canvasImg = document.createElement('canvas'); canvasImg.width = img.width; canvasImg.height = img.height;
                canvasImg.getContext('2d').drawImage(img, 0, 0);
                const dataUri = canvasImg.toDataURL('image/jpeg', 0.85);
                const imgProps = pdf.getImageProperties(dataUri);
                const pdfWidth = PAGE_W - MARGIN * 2;
                let pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

                // Respeta proporción SIEMPRE; si no cabe en una página, la escala para que quepa
                // completa (nunca se recorta ni se deforma) y sigue con el resto debajo/en otra página.
                const availableH = MAX_Y - yPos;
                if (pdfHeight > availableH) {
                    if (availableH < 40 && yPos > 25) { pdf.addPage(); yPos = 20; }
                    const finalAvailable = MAX_Y - yPos;
                    if (pdfHeight > finalAvailable) {
                        const scale = finalAvailable / pdfHeight;
                        pdf.addImage(dataUri, 'JPEG', MARGIN, yPos, pdfWidth * scale, finalAvailable);
                        yPos += finalAvailable + 8;
                    } else {
                        pdf.addImage(dataUri, 'JPEG', MARGIN, yPos, pdfWidth, pdfHeight);
                        yPos += pdfHeight + 8;
                    }
                } else {
                    pdf.addImage(dataUri, 'JPEG', MARGIN, yPos, pdfWidth, pdfHeight);
                    yPos += pdfHeight + 8;
                }
            } catch (e) { console.error("Saltando imagen inaccesible por CORS"); }
        }

        if (rec.nota) {
            const lines = pdf.splitTextToSize("Nota: " + rec.nota, 190);
            if (yPos + lines.length * 6 > MAX_Y) { pdf.addPage(); yPos = 20; }
            pdf.setFontSize(11); pdf.setTextColor(0); pdf.text(lines, MARGIN, yPos); yPos += lines.length * 6 + 4;
        }

        (rec.comentarios || []).forEach((c) => {
            const lines = pdf.splitTextToSize(`[${c.fecha}] ${c.texto}`, 185);
            if (yPos + lines.length * 5 > MAX_Y) { pdf.addPage(); yPos = 20; }
            pdf.setFontSize(9); pdf.setTextColor(90);
            pdf.text(lines, 15, yPos);
            yPos += lines.length * 5 + 2;
            pdf.setTextColor(0);
        });
    }
    pdf.save(`Apuntes_${currentContext.materia}_${currentContext.tema}.pdf`);
    btnExportPDF.textContent = "📑";
});

initApp();
