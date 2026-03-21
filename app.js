// CONFIGURACIÓN OBLIGATORIA
const GAS_URL = "https://script.google.com/macros/s/AKfycbyPIv-c9UqYflEdfiX1aCoCSHnNOz0qCGcXRkH8wxaRZd-c4bHYPOh0qbfkSJ5-Oij-/exec"; // Reemplaza esto con tu URL de Apps Script

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
        tx.oncomplete = () => resolve();
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

// --- ESTADO GLOBAL ---
// CORRECCIÓN CRÍTICA 1: Usar localStorage para persistencia permanente del PIN
let sessionPin = localStorage.getItem('iubVaultPin') || "";
let localData = { modules: [], records: [] };
let isProcessingQueue = false;
let currentFolderFilter = { materia: null, tema: null };
let currentRecordId = null;

// --- DOM ELEMENTS ---
const el = (id) => document.getElementById(id);
const loginScreen = el('loginScreen'), pinInput = el('pinInput'), btnLogin = el('btnLogin'), loginError = el('loginError');
const headerTitle = el('headerTitle'), btnSync = el('btnSync'), queueBadge = el('queueBadge');
const materiaSelect = el('materiaSelect'), temaSelect = el('temaSelect'), etiquetasInput = el('etiquetasInput'), textoNota = el('textoNota');
const galleryInput = el('galleryInput'), cameraInput = el('cameraInput');
const statusMessage = el('statusMessage');
const estructuraGrid = el('estructuraGrid'), searchInput = el('searchInput');
const tabCarpeta = el('tabCarpeta'), carpetaTitulo = el('carpetaTitulo'), carpetaSubtitulo = el('carpetaSubtitulo'), galeriaGrid = el('galeriaGrid'), btnVolverExplorador = el('btnVolverExplorador'), btnExportPDF = el('btnExportPDF');

// --- INICIALIZACIÓN ---
function initApp() {
    const cached = localStorage.getItem('iubVaultData_v2');
    if (cached) {
        try { localData = JSON.parse(cached); renderDropdowns(); renderExplorador(); } 
        catch (e) { localData = { modules: [], records: [] }; }
    }
    if (sessionPin) {
        // Al arrancar con PIN guardado, valida silenciosamente e inicia la cola offline
        validarPinRequest(sessionPin, true).then(() => { updateQueueBadge(); processQueue(); });
    } else { loginScreen.classList.remove('hide'); }
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
            
            // Verificación de integridad: Evitar crash si el backend es V1
            if (result.modules && result.modules.length > 0 && typeof result.modules[0] === 'string') {
                throw new Error("Backend V1 detectado. Publica una 'Nueva Implementación' en Apps Script.");
            }

            localData.modules = result.modules || []; localData.records = result.records || [];
            localStorage.setItem('iubVaultData_v2', JSON.stringify(localData));
            loginScreen.classList.add('hide'); loginError.classList.add('hide');
            renderDropdowns(); renderExplorador();
            if (currentFolderFilter.tema) openCarpeta(currentFolderFilter.materia, currentFolderFilter.tema);
        } else throw new Error(result.message || "Error desconocido en el servidor.");
    } catch (e) {
        if (!isSilent) { 
            loginError.textContent = e.message === "Failed to fetch" ? "Error de red o URL incorrecta." : e.message; 
            loginError.classList.remove('hide'); 
            pinInput.value = ""; 
        } else { 
            localStorage.removeItem('iubVaultPin'); 
            loginScreen.classList.remove('hide'); 
        }
    } finally { 
        if (!isSilent) { btnLogin.textContent = "Desbloquear Workspace"; btnLogin.disabled = false; } 
    }
}

btnLogin.addEventListener('click', () => { if (pinInput.value.length >= 4) validarPinRequest(pinInput.value.trim()); });
btnSync.addEventListener('click', () => { if (sessionPin) { processQueue(); validarPinRequest(sessionPin, true); } });

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
                    localData.records.unshift({
                        id: result.id, fecha: result.fecha, cuatrimestre: payload.cuatrimestre, materia: payload.materia,
                        tema: payload.tema, etiquetas: payload.etiquetas, tipo: payload.tipo, url: result.url, nota: payload.textoNota
                    });
                    localStorage.setItem('iubVaultData_v2', JSON.stringify(localData));
                    await removeFromQueue(payload.tempId);
                    renderExplorador();
                    if(currentFolderFilter.tema === payload.tema) openCarpeta(payload.materia, payload.tema);
                } else break;
            } catch (e) { break; } // Offline, pausa segura
            queue = await getQueue();
        }
    } finally { isProcessingQueue = false; updateQueueBadge(); }
}

async function updateQueueBadge() {
    const q = await getQueue();
    if (q.length > 0) { queueBadge.textContent = q.length; queueBadge.classList.remove('hidden'); }
    else queueBadge.classList.add('hidden');
}

// --- RENDERIZADO UI ---
function switchTab(tabId, title) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    el(tabId).classList.add('active'); headerTitle.textContent = title;
    document.querySelectorAll('.nav-btn').forEach(btn => { btn.classList.remove('text-gray-900', 'active-nav'); btn.classList.add('text-gray-400'); });
    event.currentTarget.classList.remove('text-gray-400'); event.currentTarget.classList.add('text-gray-900', 'active-nav');
    currentFolderFilter = { materia: null, tema: null };
}

function renderDropdowns() {
    const uniqueMaterias = [...new Set(localData.modules.map(m => m.materia))];
    materiaSelect.innerHTML = '<option value="">Selecciona Materia...</option>';
    uniqueMaterias.forEach(m => materiaSelect.innerHTML += `<option value="${m}">${m}</option>`);
    materiaSelect.onchange = () => {
        temaSelect.innerHTML = '<option value="">Selecciona Tema...</option>';
        const temas = localData.modules.filter(mod => mod.materia === materiaSelect.value).map(mod => mod.tema);
        temas.forEach(t => temaSelect.innerHTML += `<option value="${t}">${t}</option>`);
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
        if(term && !materia.toLowerCase().includes(term) && !temas.some(t => t.toLowerCase().includes(term))) continue;
        const matDiv = document.createElement('div');
        matDiv.className = "bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden";
        matDiv.innerHTML = `<div class="bg-gray-50 px-4 py-3 border-b border-gray-100 font-bold text-gray-800 text-sm flex items-center gap-2"><span class="text-iub text-lg">📚</span> ${materia}</div>`;
        
        temas.forEach(tema => {
            if(term && !materia.toLowerCase().includes(term) && !tema.toLowerCase().includes(term)) return;
            const count = localData.records.filter(r => r.materia === materia && r.tema === tema).length;
            const item = document.createElement('div');
            item.className = "px-4 py-3 flex justify-between items-center border-b border-gray-50 active:bg-gray-50 cursor-pointer";
            item.innerHTML = `<div><p class="font-semibold text-gray-700 text-sm flex items-center gap-2"><span class="text-blue-400 text-lg">📁</span> ${tema}</p><p class="text-[10px] text-gray-400 uppercase font-bold tracking-wider ml-7">${count} Documentos</p></div><span class="text-gray-300">›</span>`;
            item.onclick = () => openCarpeta(materia, tema);
            matDiv.appendChild(item);
        });
        estructuraGrid.appendChild(matDiv);
    }
}
searchInput.addEventListener('input', (e) => renderExplorador(e.target.value));

function openCarpeta(materia, tema) {
    currentFolderFilter = { materia, tema };
    carpetaTitulo.textContent = tema; carpetaSubtitulo.textContent = materia;
    galeriaGrid.innerHTML = '';
    const records = localData.records.filter(r => r.materia === materia && r.tema === tema);

    records.forEach(r => {
        const div = document.createElement('div');
        div.className = "aspect-[3/4] bg-gray-100 rounded-xl overflow-hidden shadow-sm relative active:scale-95 transition-transform";
        if (r.url) {
            div.innerHTML = `<img src="${r.url}" class="w-full h-full object-cover" loading="lazy">
            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6"><p class="text-white text-[9px] font-bold tracking-wider">${r.fecha.split(' ')[0]}</p></div>`;
            if(r.etiquetas) div.innerHTML += `<span class="absolute top-2 right-2 bg-blue-500 text-white text-[8px] px-1.5 py-0.5 rounded font-bold">${r.etiquetas.split(',')[0]}</span>`;
        } else {
            div.innerHTML = `<div class="w-full h-full p-3 text-xs text-gray-600 font-medium overflow-hidden bg-white border border-gray-200">${r.nota}</div>`;
        }
        div.onclick = () => showModal(r);
        galeriaGrid.appendChild(div);
    });
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    tabCarpeta.classList.add('active');
}
btnVolverExplorador.addEventListener('click', () => switchTab('tabExplorador', 'Explorador'));

// --- MÓDULO DE AUTO-COMMIT (Flujo Directo) ---
async function commitToVault(filesArray = []) {
    const mat = materiaSelect.value; const tem = temaSelect.value;
    if(!mat || !tem) { alert("⚠️ Selecciona Materia y Tema primero."); return false; }
    
    const cuatri = localData.modules.find(m => m.materia === mat).cuatrimestre;
    const tags = etiquetasInput.value;
    const nota = textoNota.value;
    
    statusMessage.textContent = "⏳ Guardando en IndexedDB..."; 
    statusMessage.classList.remove('hidden');

    // Múltiples archivos (Fotos/Galería)
    for(let file of filesArray) {
        const blob = await compressFileToBlob(file);
        await addToQueue({ action: "save", pin: sessionPin, cuatrimestre: cuatri, materia: mat, tema: tem, etiquetas: tags, tipo: "ARCHIVO", textoNota: nota, blobFile: blob });
    }

    // Texto solo (si no hay archivos pero hay notas escritas, poco común en este flujo pero útil)
    if(filesArray.length === 0 && nota.trim() !== "") {
        await addToQueue({ action: "save", pin: sessionPin, cuatrimestre: cuatri, materia: mat, tema: tem, etiquetas: tags, tipo: "TEXTO", textoNota: nota });
    }
    
    // Limpiar UI optimista
    etiquetasInput.value = ""; textoNota.value = "";
    statusMessage.textContent = "✅ Guardado localmente. Sincronizando...";
    setTimeout(() => statusMessage.classList.add('hidden'), 2500);
    
    // Disparar background worker
    updateQueueBadge(); processQueue();
    return true;
}

galleryInput.addEventListener('change', (e) => { if(e.target.files.length > 0) commitToVault(Array.from(e.target.files)); });
cameraInput.addEventListener('change', (e) => { if(e.target.files.length > 0) commitToVault(Array.from(e.target.files)); });

// --- MOTOR S-PEN V2 (120HZ ALTA PRECISIÓN Y AUTO-COMMIT) ---
const canvasOverlay = el('drawingOverlay'), canvas = el('canvasNote'), ctx = canvas.getContext('2d', { desynchronized: true });
let isDrawing = false, lastMid = null, currentColor = '#000000', currentBg = 'bg-white';

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight - 100; clearCanvasUI(); }
function clearCanvasUI() {
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if(currentBg === 'bg-lines') {
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
        for(let i=24; i<canvas.height; i+=24) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); }
    } else if (currentBg === 'bg-grid') {
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
        for(let i=24; i<canvas.height; i+=24) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); }
        for(let j=24; j<canvas.width; j+=24) { ctx.beginPath(); ctx.moveTo(j, 0); ctx.lineTo(j, canvas.height); ctx.stroke(); }
    }
}

el('btnOpenNotebook').addEventListener('click', () => { 
    if(!materiaSelect.value || !temaSelect.value) { alert("⚠️ Selecciona Materia y Tema antes de dibujar."); return; }
    resizeCanvas(); canvasOverlay.classList.remove('hide'); 
});
el('btnCerrarCanvas').addEventListener('click', () => canvasOverlay.classList.add('hide'));
el('btnBorrarLienzo').addEventListener('click', clearCanvasUI);

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

// CORRECCIÓN CRÍTICA 2: API getCoalescedEvents para pantallas de 120Hz (S-Pen)
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
    
    // Obtener todos los micro-movimientos saltados por el navegador
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const rect = canvas.getBoundingClientRect();
    
    for (let ev of events) {
        const current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const mid = { x: (lastMid.x + current.x) / 2, y: (lastMid.y + current.y) / 2 };
        
        ctx.lineWidth = ev.pressure ? ev.pressure * 5 + 1 : 2;
        ctx.beginPath();
        ctx.moveTo(lastMid.x, lastMid.y);
        ctx.quadraticCurveTo(lastMid.x, lastMid.y, mid.x, mid.y); // Curva suave
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
        const cuatri = localData.modules.find(m => m.materia === mat).cuatrimestre;
        
        statusMessage.textContent = "⏳ Guardando apunte..."; statusMessage.classList.remove('hidden');
        await addToQueue({ action: "save", pin: sessionPin, cuatrimestre: cuatri, materia: mat, tema: tem, etiquetas: etiquetasInput.value, tipo: "NOTA_SPEN", textoNota: textoNota.value, blobFile: blob });
        
        etiquetasInput.value = ""; textoNota.value = "";
        statusMessage.textContent = "✅ Apunte guardado localmente.";
        setTimeout(() => statusMessage.classList.add('hidden'), 2500);
        updateQueueBadge(); processQueue();
    }, 'image/jpeg', 0.9);
});

// --- CRUD & VISOR ---
const imageModal = el('imageModal'), fullImage = el('fullImage'), modalDate = el('modalDate'), modalTags = el('modalTags'), modalNote = el('modalNote');
function showModal(record) {
    currentRecordId = record.id; modalDate.textContent = record.fecha; modalTags.textContent = record.etiquetas ? `#${record.etiquetas.replace(/,/g, ' #')}` : '';
    fullImage.src = record.url || ""; fullImage.style.display = record.url ? "block" : "none";
    modalNote.textContent = record.nota || "Sin texto asociado.";
    el('btnDownload').style.display = record.url ? "flex" : "none"; el('btnShare').style.display = record.url ? "flex" : "none";
    imageModal.classList.remove('hide');
}
el('btnCloseModal').addEventListener('click', () => imageModal.classList.add('hide'));

function swapRecords(dir) {
    let recs = localData.records.filter(r => r.materia === currentFolderFilter.materia && r.tema === currentFolderFilter.tema);
    let i = recs.findIndex(r => r.id === currentRecordId);
    if(i < 0) return;
    let t = i + dir; if(t < 0 || t >= recs.length) return;
    let g1 = localData.records.findIndex(r => r.id === currentRecordId), g2 = localData.records.findIndex(r => r.id === recs[t].id);
    let tmp = localData.records[g1]; localData.records[g1] = localData.records[g2]; localData.records[g2] = tmp;
    localStorage.setItem('iubVaultData_v2', JSON.stringify(localData)); openCarpeta(currentFolderFilter.materia, currentFolderFilter.tema);
}
el('btnMoveLeft').addEventListener('click', () => swapRecords(-1)); el('btnMoveRight').addEventListener('click', () => swapRecords(1));

el('btnDelete').addEventListener('click', async () => {
    if(!confirm("¿Eliminar archivo permanentemente?")) return;
    const rec = localData.records.find(r => r.id === currentRecordId);
    let dId = rec.url ? rec.url.split('/d/')[1] || rec.url.split('picture/2')[1] : null;
    try {
        await fetch(GAS_URL, { method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "delete", pin: sessionPin, idRegistro: currentRecordId, fileId: dId }) });
        localData.records = localData.records.filter(r => r.id !== currentRecordId);
        localStorage.setItem('iubVaultData_v2', JSON.stringify(localData));
        imageModal.classList.add('hide'); openCarpeta(currentFolderFilter.materia, currentFolderFilter.tema); renderExplorador();
    } catch(e) { alert("Error al eliminar."); }
});

el('btnShare').addEventListener('click', async () => {
    const r = localData.records.find(x => x.id === currentRecordId);
    if(r && navigator.share) navigator.share({ title: r.tema, text: r.nota, url: r.url }).catch(()=>{});
});
el('btnDownload').addEventListener('click', () => {
    const r = localData.records.find(x => x.id === currentRecordId);
    if(r && r.url) window.open(r.url, '_blank');
});

// --- AJUSTES Y CREACIÓN ---
el('btnAgregarEstructura').addEventListener('click', async () => {
    const q = el('nuevoCuatrimestre').value, m = el('nuevaMateria').value.trim(), t = el('nuevoTema').value.trim();
    if(!q || !m || !t) return;
    el('ajustesStatus').textContent = "Creando..."; el('ajustesStatus').classList.remove('hidden'); el('btnAgregarEstructura').disabled = true;
    try {
        const res = await fetch(GAS_URL, { method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "add_module", pin: sessionPin, cuatrimestre: q, materia: m, tema: t }) });
        const result = await res.json();
        if(result.status === "success") {
            localData.modules.push(result.newModule); localStorage.setItem('iubVaultData_v2', JSON.stringify(localData));
            renderDropdowns(); renderExplorador(); el('ajustesStatus').textContent = "✅ Creado";
            el('nuevaMateria').value = ""; el('nuevoTema').value = ""; setTimeout(() => el('ajustesStatus').classList.add('hidden'), 2000);
        }
    } catch(e) {} finally { el('btnAgregarEstructura').disabled = false; }
});
el('btnLimpiarCache').addEventListener('click', () => { localStorage.clear(); location.reload(); });

// --- EXPORTACIÓN PDF PROFESIONAL (JSPDF) ---
btnExportPDF.addEventListener('click', async () => {
    if(!currentFolderFilter.tema) return;
    const { jsPDF } = window.jspdf; const doc = new jsPDF('p', 'mm', 'a4');
    const records = localData.records.filter(r => r.materia === currentFolderFilter.materia && r.tema === currentFolderFilter.tema && r.url);
    if(records.length === 0) return alert("No hay imágenes para exportar.");
    
    btnExportPDF.textContent = "Generando...";
    doc.setFontSize(22); doc.text(currentFolderFilter.materia, 10, 20);
    doc.setFontSize(14); doc.text(`Tema: ${currentFolderFilter.tema}`, 10, 30);
    doc.setFontSize(10); doc.text(`Generado: ${new Date().toLocaleDateString()}`, 10, 40);

    let yPos = 50;
    for(let i = 0; i < records.length; i++) {
        if (i > 0) { doc.addPage(); yPos = 20; }
        try {
            const img = new Image(); img.crossOrigin = "Anonymous"; img.src = records[i].url;
            await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
            const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            const dataUri = canvas.toDataURL('image/jpeg', 0.8);
            const imgProps = doc.getImageProperties(dataUri);
            const pdfWidth = doc.internal.pageSize.getWidth() - 20;
            const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
            
            doc.addImage(dataUri, 'JPEG', 10, yPos, pdfWidth, pdfHeight);
            if(records[i].nota) { doc.text(records[i].nota.substring(0,100), 10, yPos + pdfHeight + 10); }
        } catch(e) { console.error("Saltando imagen inaccesible por CORS"); }
    }
    doc.save(`IUB_Vault_${currentFolderFilter.materia}_${currentFolderFilter.tema}.pdf`);
    btnExportPDF.textContent = "📑 Generar PDF";
});

initApp();
