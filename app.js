// CONFIGURACIÓN OBLIGATORIA
const GAS_URL = "https://script.google.com/macros/s/AKfycbyPIv-c9UqYflEdfiX1aCoCSHnNOz0qCGcXRkH8wxaRZd-c4bHYPOh0qbfkSJ5-Oij-/exec";

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

// --- UTILIDADES DE COMPRESIÓN (EDGE COMPUTING) ---
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

// --- SEGURIDAD: ESCAPE DE HTML (evita inyección al renderizar datos) ---
function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// --- ESTADO GLOBAL ---
let sessionPin = localStorage.getItem('iubVaultPin') || "";
let localData = { modules: [], records: [] };
let isProcessingQueue = false;
let currentFolderFilter = { materia: null, tema: null };
let currentRecordId = null;
let modalContext = { list: [], index: -1 };

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
const materiaSelect = el('materiaSelect'), temaSelect = el('temaSelect'), etiquetasInput = el('etiquetasInput'), textoNota = el('textoNota');
const galleryInput = el('galleryInput'), cameraInput = el('cameraInput');
const statusMessage = el('statusMessage');
const estructuraGrid = el('estructuraGrid'), searchInput = el('searchInput');
const tabCarpeta = el('tabCarpeta'), carpetaTitulo = el('carpetaTitulo'), carpetaSubtitulo = el('carpetaSubtitulo'), galeriaGrid = el('galeriaGrid'), btnVolverExplorador = el('btnVolverExplorador'), btnExportPDF = el('btnExportPDF');

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
        try { localData = JSON.parse(cached); renderDropdowns(); renderExplorador(); }
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

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
}

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

            localData.modules = result.modules || []; localData.records = result.records || [];
            saveLocalData();
            loginScreen.classList.add('hide'); loginError.classList.add('hide');
            renderDropdowns(); renderExplorador();
            if (currentFolderFilter.tema) openCarpeta(currentFolderFilter.materia, currentFolderFilter.tema);
            hideBanner();
        } else if (result.code === "INVALID_PIN") {
            // PIN realmente incorrecto: sí cerramos sesión.
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
            // Error del servidor (bloqueo temporal, cuota, etc.): NO cerramos sesión, solo avisamos.
            const msg = result.message || "Error del servidor.";
            if (!isSilent) { loginError.textContent = msg; loginError.classList.remove('hide'); }
            else { showBanner("⚠️ " + msg, "warn"); }
        }
    } catch (e) {
        // Fallo de red/parseo: nunca cerramos sesión por esto.
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
        localData.records.unshift({
            id: result.id, fecha: result.fecha, cuatrimestre: payload.cuatrimestre, materia: payload.materia,
            tema: payload.tema, etiquetas: payload.etiquetas, tipo: payload.tipo, url: result.url,
            fileId: result.fileId || "", nota: payload.textoNota, comentarios: []
        });
        saveLocalData();
        renderExplorador();
        if (currentFolderFilter.tema === payload.tema && currentFolderFilter.materia === payload.materia) openCarpeta(payload.materia, payload.tema);
    } else if (payload.action === "add_comment") {
        const rec = localData.records.find(r => r.id === payload.idRegistro);
        if (rec) {
            if (!rec.comentarios) rec.comentarios = [];
            if (payload.localCommentId) rec.comentarios = rec.comentarios.filter(c => c.id !== payload.localCommentId);
            const already = rec.comentarios.some(c => c.id === result.id);
            if (!already) rec.comentarios.push({ id: result.id, fecha: result.fecha, texto: result.texto });
            saveLocalData();
            if (currentRecordId === rec.id) renderModalComments(rec);
        }
    } else if (payload.action === "delete") {
        // Ya se removió de forma optimista al hacer clic en eliminar.
    }
}

async function updateQueueBadge() {
    const q = await getQueue();
    if (q.length > 0) { queueBadge.textContent = q.length; queueBadge.classList.remove('hidden'); }
    else queueBadge.classList.add('hidden');
}

// --- RENDERIZADO UI ---
function switchTab(tabId, title, btnEl) {
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    el(tabId).classList.add('active'); headerTitle.textContent = title;
    document.querySelectorAll('.nav-btn').forEach(btn => { btn.classList.remove('text-gray-900', 'active-nav'); btn.classList.add('text-gray-400'); });
    if (btnEl) { btnEl.classList.remove('text-gray-400'); btnEl.classList.add('text-gray-900', 'active-nav'); }
    currentFolderFilter = { materia: null, tema: null };
}

function renderDropdowns() {
    const uniqueMaterias = [...new Set(localData.modules.map(m => m.materia))];
    materiaSelect.innerHTML = '<option value="">Selecciona Materia...</option>';
    uniqueMaterias.forEach(m => materiaSelect.innerHTML += `<option value="${esc(m)}">${esc(m)}</option>`);
    materiaSelect.onchange = () => {
        temaSelect.innerHTML = '<option value="">Selecciona Tema...</option>';
        const temas = localData.modules.filter(mod => mod.materia === materiaSelect.value).map(mod => mod.tema);
        temas.forEach(t => temaSelect.innerHTML += `<option value="${esc(t)}">${esc(t)}</option>`);
    };
}

function renderExplorador(filterText = "") {
    estructuraGrid.innerHTML = '';
    const term = filterText.toLowerCase();
    const grouped = {};
    localData.modules.forEach(mod => {
        if (!grouped[mod.materia]) grouped[mod.materia] = [];
        grouped[mod.materia].push(mod.tema);
    });

    for (const [materia, temas] of Object.entries(grouped)) {
        const materiaMatches = materia.toLowerCase().includes(term);
        const anyTemaOrTagMatches = temas.some(t => t.toLowerCase().includes(term)) ||
            localData.records.some(r => r.materia === materia && r.etiquetas && r.etiquetas.toLowerCase().includes(term));
        if (term && !materiaMatches && !anyTemaOrTagMatches) continue;

        const matDiv = document.createElement('div');
        matDiv.className = "bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden";
        matDiv.innerHTML = `<div class="bg-gray-50 px-4 py-3 border-b border-gray-100 font-bold text-gray-800 text-sm flex items-center gap-2"><span class="text-iub text-lg">📚</span> ${esc(materia)}</div>`;

        temas.forEach(tema => {
            const tagMatch = localData.records.some(r => r.materia === materia && r.tema === tema && r.etiquetas && r.etiquetas.toLowerCase().includes(term));
            if (term && !materiaMatches && !tema.toLowerCase().includes(term) && !tagMatch) return;
            const count = localData.records.filter(r => r.materia === materia && r.tema === tema).length;
            const item = document.createElement('div');
            item.className = "px-4 py-3 flex justify-between items-center border-b border-gray-50 active:bg-gray-50 cursor-pointer";
            item.innerHTML = `<div><p class="font-semibold text-gray-700 text-sm flex items-center gap-2"><span class="text-blue-400 text-lg">📁</span> ${esc(tema)}</p><p class="text-[10px] text-gray-400 uppercase font-bold tracking-wider ml-7">${count} Documentos</p></div><span class="text-gray-300">›</span>`;
            item.onclick = () => openCarpeta(materia, tema);
            matDiv.appendChild(item);
        });
        estructuraGrid.appendChild(matDiv);
    }
}
searchInput.addEventListener('input', (e) => renderExplorador(e.target.value));

// --- CUADERNO: agrupación cronológica por día ---
function formatFechaLarga(fechaStr) {
    const soloFecha = (fechaStr || "").split(' ')[0];
    const [y, m, d] = soloFecha.split('-').map(Number);
    if (!y) return soloFecha;
    const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    return `${d} de ${meses[m - 1]} de ${y}`;
}

function openCarpeta(materia, tema) {
    currentFolderFilter = { materia, tema };
    carpetaTitulo.textContent = tema; carpetaSubtitulo.textContent = materia;
    galeriaGrid.innerHTML = '';

    const records = localData.records
        .filter(r => r.materia === materia && r.tema === tema)
        .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

    if (records.length === 0) {
        galeriaGrid.innerHTML = `<p class="col-span-2 text-center text-gray-400 text-sm py-10">Aún no hay páginas en este cuaderno.</p>`;
    }

    let lastDay = null;
    records.forEach(r => {
        const day = (r.fecha || "").split(' ')[0];
        if (day !== lastDay) {
            lastDay = day;
            const header = document.createElement('div');
            header.className = "col-span-2 pt-3 pb-1 first:pt-0";
            header.innerHTML = `<p class="text-[11px] font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100 pb-1">🗓️ ${esc(formatFechaLarga(r.fecha))}</p>`;
            galeriaGrid.appendChild(header);
        }

        const div = document.createElement('div');
        div.className = "aspect-[3/4] bg-gray-100 rounded-xl overflow-hidden shadow-sm relative active:scale-95 transition-transform";
        const commentCount = (r.comentarios || []).length;
        if (r.url) {
            div.innerHTML = `<img src="${esc(r.url)}" class="w-full h-full object-cover" loading="lazy">
            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6"><p class="text-white text-[9px] font-bold tracking-wider">${esc(r.fecha.split(' ')[1] || '')}</p></div>`;
            if (r.etiquetas) div.innerHTML += `<span class="absolute top-2 right-2 bg-blue-500 text-white text-[8px] px-1.5 py-0.5 rounded font-bold">${esc(r.etiquetas.split(',')[0])}</span>`;
        } else {
            div.innerHTML = `<div class="w-full h-full p-3 text-xs text-gray-600 font-medium overflow-hidden bg-white border border-gray-200">${esc(r.nota)}</div>`;
        }
        if (commentCount > 0) div.innerHTML += `<span class="absolute top-2 left-2 bg-gray-900/80 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold">💬 ${commentCount}</span>`;
        div.onclick = () => showModal(r, records);
        galeriaGrid.appendChild(div);
    });
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    tabCarpeta.classList.add('active');
}
btnVolverExplorador.addEventListener('click', () => switchTab('tabExplorador', 'Explorador'));

// --- MÓDULO DE AUTO-COMMIT (Flujo Directo) ---
async function commitToVault(filesArray = []) {
    const mat = materiaSelect.value; const tem = temaSelect.value;
    if (!mat || !tem) { alert("⚠️ Selecciona Materia y Tema primero."); return false; }

    const moduleMatch = localData.modules.find(m => m.materia === mat);
    const cuatri = moduleMatch ? moduleMatch.cuatrimestre : "General";
    const tags = etiquetasInput.value;
    const nota = textoNota.value;

    statusMessage.textContent = "⏳ Guardando en el dispositivo...";
    statusMessage.classList.remove('hidden');

    for (let file of filesArray) {
        const blob = await compressFileToBlob(file);
        await addToQueue({ action: "save", pin: sessionPin, cuatrimestre: cuatri, materia: mat, tema: tem, etiquetas: tags, tipo: "ARCHIVO", textoNota: nota, blobFile: blob });
    }

    if (filesArray.length === 0 && nota.trim() !== "") {
        await addToQueue({ action: "save", pin: sessionPin, cuatrimestre: cuatri, materia: mat, tema: tem, etiquetas: tags, tipo: "TEXTO", textoNota: nota });
    }

    etiquetasInput.value = ""; textoNota.value = "";
    statusMessage.textContent = "✅ Guardado localmente. Sincronizando...";
    setTimeout(() => statusMessage.classList.add('hidden'), 2500);

    updateQueueBadge(); processQueue();
    return true;
}

galleryInput.addEventListener('change', (e) => { if (e.target.files.length > 0) commitToVault(Array.from(e.target.files)); e.target.value = ""; });
cameraInput.addEventListener('change', (e) => { if (e.target.files.length > 0) commitToVault(Array.from(e.target.files)); e.target.value = ""; });

// --- MOTOR S-PEN V2 (120HZ ALTA PRECISIÓN Y AUTO-COMMIT) ---
const canvasOverlay = el('drawingOverlay'), canvas = el('canvasNote'), ctx = canvas.getContext('2d', { desynchronized: true });
let isDrawing = false, lastMid = null, currentColor = '#000000', currentBg = 'bg-white';

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight - 100; clearCanvasUI(); }
function clearCanvasUI() {
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (currentBg === 'bg-lines') {
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
        for (let i = 24; i < canvas.height; i += 24) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); }
    } else if (currentBg === 'bg-grid') {
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
        for (let i = 24; i < canvas.height; i += 24) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); }
        for (let j = 24; j < canvas.width; j += 24) { ctx.beginPath(); ctx.moveTo(j, 0); ctx.lineTo(j, canvas.height); ctx.stroke(); }
    }
}

el('btnOpenNotebook').addEventListener('click', () => {
    if (!materiaSelect.value || !temaSelect.value) { alert("⚠️ Selecciona Materia y Tema antes de dibujar."); return; }
    resizeCanvas(); canvasOverlay.classList.remove('hide');
});
el('btnCerrarCanvas').addEventListener('click', () => canvasOverlay.classList.add('hide'));
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

// Auto-Commit desde Canvas
el('btnGuardarCanvas').addEventListener('click', () => {
    canvas.toBlob(async (blob) => {
        canvasOverlay.classList.add('hide');
        const mat = materiaSelect.value; const tem = temaSelect.value;
        if (!mat || !tem) return;
        const moduleMatch = localData.modules.find(m => m.materia === mat);
        const cuatri = moduleMatch ? moduleMatch.cuatrimestre : "General";

        statusMessage.textContent = "⏳ Guardando apunte..."; statusMessage.classList.remove('hidden');
        await addToQueue({ action: "save", pin: sessionPin, cuatrimestre: cuatri, materia: mat, tema: tem, etiquetas: etiquetasInput.value, tipo: "NOTA_SPEN", textoNota: textoNota.value, blobFile: blob });

        etiquetasInput.value = ""; textoNota.value = "";
        statusMessage.textContent = "✅ Apunte guardado localmente.";
        setTimeout(() => statusMessage.classList.add('hidden'), 2500);
        updateQueueBadge(); processQueue();
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
    if (!comentarioId.toString().startsWith('local_')) {
        await addToQueue({ action: "delete_comment", pin: sessionPin, idComentario: comentarioId });
        updateQueueBadge(); processQueue();
    }
}

el('btnAddComentario').addEventListener('click', async () => {
    const texto = comentarioInput.value.trim();
    if (!texto || !currentRecordId) return;
    const record = localData.records.find(r => r.id === currentRecordId);
    if (!record) return;

    const fechaLocal = new Date().toISOString().slice(0, 16).replace('T', ' ');
    if (!record.comentarios) record.comentarios = [];
    const tempId = 'local_' + Date.now();
    record.comentarios.push({ id: tempId, fecha: fechaLocal, texto });
    saveLocalData();
    renderModalComments(record);
    comentarioInput.value = "";

    await addToQueue({ action: "add_comment", pin: sessionPin, idRegistro: currentRecordId, texto, localCommentId: tempId });
    updateQueueBadge(); processQueue();
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
    const fileId = rec.fileId || (rec.url ? (rec.url.split('/d/')[1] || null) : null);

    // Borrado optimista: se ve al instante y funciona sin conexión (se confirma al servidor luego).
    localData.records = localData.records.filter(r => r.id !== currentRecordId);
    saveLocalData();
    imageModal.classList.add('hide');
    if (currentFolderFilter.tema) openCarpeta(currentFolderFilter.materia, currentFolderFilter.tema);
    renderExplorador();

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

// --- AJUSTES Y CREACIÓN ---
el('btnAgregarEstructura').addEventListener('click', async () => {
    const q = el('nuevoCuatrimestre').value, m = el('nuevaMateria').value.trim(), t = el('nuevoTema').value.trim();
    if (!q || !m || !t) return;
    const statusEl = el('ajustesStatus');
    statusEl.textContent = "Creando..."; statusEl.classList.remove('hidden'); el('btnAgregarEstructura').disabled = true;
    if (!navigator.onLine) {
        statusEl.textContent = "⚠️ Necesitas conexión para crear una carpeta nueva.";
        el('btnAgregarEstructura').disabled = false;
        return;
    }
    try {
        const res = await fetch(GAS_URL, { method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "add_module", pin: sessionPin, cuatrimestre: q, materia: m, tema: t }) });
        const result = await res.json();
        if (result.status === "success") {
            localData.modules.push(result.newModule); saveLocalData();
            renderDropdowns(); renderExplorador(); statusEl.textContent = "✅ Creado";
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
    if (!currentFolderFilter.tema) return;
    const { jsPDF } = window.jspdf; const doc = new jsPDF('p', 'mm', 'a4');
    const records = localData.records
        .filter(r => r.materia === currentFolderFilter.materia && r.tema === currentFolderFilter.tema)
        .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    if (records.length === 0) return alert("No hay páginas para exportar.");

    btnExportPDF.textContent = "Generando...";
    doc.setFontSize(22); doc.text(currentFolderFilter.materia, 10, 20);
    doc.setFontSize(14); doc.text(`Tema: ${currentFolderFilter.tema}`, 10, 30);
    doc.setFontSize(10); doc.text(`Generado: ${new Date().toLocaleDateString()}`, 10, 40);

    let first = true;
    for (const rec of records) {
        if (!first) { doc.addPage(); }
        first = false;
        let yPos = 20;
        doc.setFontSize(10); doc.text(rec.fecha || "", 10, yPos); yPos += 8;

        if (rec.url) {
            try {
                const img = new Image(); img.crossOrigin = "Anonymous"; img.src = rec.url;
                await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
                const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const dataUri = canvas.toDataURL('image/jpeg', 0.8);
                const imgProps = doc.getImageProperties(dataUri);
                const pdfWidth = doc.internal.pageSize.getWidth() - 20;
                const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
                doc.addImage(dataUri, 'JPEG', 10, yPos, pdfWidth, pdfHeight);
                yPos += pdfHeight + 8;
            } catch (e) { console.error("Saltando imagen inaccesible por CORS"); }
        }

        if (rec.nota) { doc.setFontSize(11); yPos += doc.splitTextToSize(rec.nota, 190).length === 0 ? 0 : 0; doc.text(doc.splitTextToSize("Nota: " + rec.nota, 190), 10, yPos); yPos += doc.splitTextToSize(rec.nota, 190).length * 6 + 4; }

        (rec.comentarios || []).forEach(c => {
            const lines = doc.splitTextToSize(`[${c.fecha}] ${c.texto}`, 185);
            if (yPos + lines.length * 5 > 280) { doc.addPage(); yPos = 20; }
            doc.setFontSize(9); doc.setTextColor(90);
            doc.text(lines, 15, yPos);
            yPos += lines.length * 5 + 2;
            doc.setTextColor(0);
        });
    }
    doc.save(`IUB_Vault_${currentFolderFilter.materia}_${currentFolderFilter.tema}.pdf`);
    btnExportPDF.textContent = "📑 Generar PDF";
});

initApp();
