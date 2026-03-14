// CONFIGURACIÓN: Reemplaza con tu URL
const GAS_URL = "https://script.google.com/macros/s/AKfycbyPIv-c9UqYflEdfiX1aCoCSHnNOz0qCGcXRkH8wxaRZd-c4bHYPOh0qbfkSJ5-Oij-/exec";

// CONFIGURACIÓN: Reemplaza con tu URL
const GAS_URL = "URL_DE_TU_WEB_APP_AQUI";

// --- MOTOR DE BASE DE DATOS LOCAL (INDEXEDDB) ---
const DB_NAME = 'IUBVaultDB';
const DB_VERSION = 1;
const STORE_NAME = 'uploadQueue';

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'tempId' });
        }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

async function addToQueue(payload) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        payload.tempId = Date.now().toString(); // ID Temporal
        store.put(payload);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getQueue() {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function removeFromQueue(tempId) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(tempId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
// ------------------------------------------------

const loginScreen = document.getElementById('loginScreen');
const pinInput = document.getElementById('pinInput');
const btnLogin = document.getElementById('btnLogin');
const loginError = document.getElementById('loginError');

const headerTitle = document.getElementById('headerTitle');
const btnSync = document.getElementById('btnSync');
const queueBadge = document.getElementById('queueBadge');

const tabCaptura = document.getElementById('tabCaptura');
const tabModulos = document.getElementById('tabModulos');
const tabGaleria = document.getElementById('tabGaleria');
const tabAjustes = document.getElementById('tabAjustes');
const navBtns = document.querySelectorAll('.nav-btn');

const cuatrimestreInput = document.getElementById('cuatrimestreInput');
const materiaSelect = document.getElementById('materiaSelect');
const modoSelect = document.getElementById('modoSelect');
const panelFoto = document.getElementById('panelFoto');
const panelSpen = document.getElementById('panelSpen');
const cameraInput = document.getElementById('cameraInput');
const imagePreview = document.getElementById('imagePreview');
const previewContainer = document.getElementById('previewContainer');
const canvas = document.getElementById('canvasNota');
const ctx = canvas.getContext('2d');
const btnLimpiarCanvas = document.getElementById('btnLimpiarCanvas');
const btnGuardar = document.getElementById('btnGuardar');
const statusMessage = document.getElementById('statusMessage');

const modulosGrid = document.getElementById('modulosGrid');
const galeriaGrid = document.getElementById('galeriaGrid');
const galeriaTitulo = document.getElementById('galeriaTitulo');
const btnVolverModulos = document.getElementById('btnVolverModulos');

const nuevaMateriaInput = document.getElementById('nuevaMateriaInput');
const nuevoCuatrimestreInput = document.getElementById('nuevoCuatrimestreInput');
const btnAgregarMateria = document.getElementById('btnAgregarMateria');
const ajustesStatus = document.getElementById('ajustesStatus');
const btnLimpiarCache = document.getElementById('btnLimpiarCache');

const imageModal = document.getElementById('imageModal');
const fullImage = document.getElementById('fullImage');
const modalDate = document.getElementById('modalDate');
const modalNote = document.getElementById('modalNote');
const btnCloseModal = document.getElementById('btnCloseModal');

const btnMoveLeft = document.getElementById('btnMoveLeft');
const btnMoveRight = document.getElementById('btnMoveRight');
const btnShare = document.getElementById('btnShare');
const btnDownload = document.getElementById('btnDownload');
const btnDelete = document.getElementById('btnDelete');

let sessionPin = sessionStorage.getItem('iubVaultPin') || "";
let localData = { modules: [], records: [] };
let isDrawing = false;
let fotoBase64 = null;
let currentRecordId = null; 
let currentMateriaGallery = null;
let isProcessingQueue = false;

function initApp() {
    const cachedData = localStorage.getItem('iubVaultData');
    if (cachedData) {
        try {
            localData = JSON.parse(cachedData);
            if (!localData.modules) localData.modules = [];
            if (!localData.records) localData.records = [];
            renderModulesDropdown();
            renderModulesGrid();
        } catch (e) {
            localStorage.removeItem('iubVaultData');
            localData = { modules: [], records: [] };
        }
    }
    
    if (sessionPin) {
        validarPinRequest(sessionPin, true).then(() => {
            updateQueueBadge();
            processQueue(); // Dispara la cola al iniciar si hay offline guardados
        });
    } else {
        loginScreen.classList.remove('hide');
    }
}

async function updateQueueBadge() {
    const items = await getQueue();
    if (items.length > 0) {
        queueBadge.textContent = `${items.length}⬆`;
        queueBadge.classList.remove('hidden');
    } else {
        queueBadge.classList.add('hidden');
    }
}

// BACKGROUND WORKER (Optimistic Uploads)
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        let queueItems = await getQueue();
        while (queueItems.length > 0) {
            updateQueueBadge();
            const payload = queueItems[0];
            
            try {
                const response = await fetch(GAS_URL, { 
                    method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, 
                    body: JSON.stringify(payload) 
                });
                const result = await response.json();
                
                if (result.status === "success") {
                    // Indexar registro real
                    localData.records.unshift({
                        id: result.id, fecha: result.fecha, cuatrimestre: payload.cuatrimestre,
                        materia: payload.materia, tipo: payload.tipo, url: result.url, nota: payload.textoNota
                    });
                    localStorage.setItem('iubVaultData', JSON.stringify(localData));
                    
                    await removeFromQueue(payload.tempId);
                    
                    // Actualizar UI sutilmente
                    renderModulesGrid();
                    if(currentMateriaGallery === payload.materia) openGallery(payload.materia);
                } else {
                    console.error("Error del servidor, reintentará luego");
                    break; // Cortar bucle si falla para no ahogar la red
                }
            } catch (netErr) {
                console.error("Sin conexión, en pausa");
                break; // Cortar bucle, no hay internet
            }
            
            queueItems = await getQueue(); // Chequear si entraron más fotos
        }
    } finally {
        isProcessingQueue = false;
        updateQueueBadge();
    }
}

async function validarPinRequest(pin, isSilent = false) {
    if (!isSilent) {
        btnLogin.textContent = "Verificando..."; btnLogin.disabled = true;
    }
    try {
        const res = await fetch(GAS_URL, {
            method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "sync", pin: pin })
        });
        const result = await res.json();
        if (result.status === "success") {
            sessionPin = pin; sessionStorage.setItem('iubVaultPin', pin);
            localData.modules = result.modules || [];
            localData.records = result.records || [];
            localStorage.setItem('iubVaultData', JSON.stringify(localData));
            loginScreen.classList.add('hide'); renderModulesDropdown(); renderModulesGrid();
            if(currentMateriaGallery) openGallery(currentMateriaGallery);
            loginError.classList.add('hide');
        } else { throw new Error(result.message); }
    } catch (e) {
        if (!isSilent) {
            loginError.classList.remove('hide'); pinInput.value = "";
        } else {
            sessionStorage.removeItem('iubVaultPin'); loginScreen.classList.remove('hide');
        }
    } finally {
        if (!isSilent) { btnLogin.textContent = "Desbloquear"; btnLogin.disabled = false; }
    }
}

btnLogin.addEventListener('click', () => {
    const pin = pinInput.value.trim();
    if (pin.length < 4) return;
    validarPinRequest(pin, false).then(() => processQueue());
});

btnSync.addEventListener('click', async () => {
    if (!sessionPin) return;
    processQueue(); // Forzar procesamiento de cola
    await validarPinRequest(sessionPin, true);
});

function switchTab(tabId, title) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    headerTitle.textContent = title;
    navBtns.forEach(btn => {
        btn.classList.remove('iub-blue-text'); btn.classList.add('text-gray-500');
    });
    event.currentTarget.classList.remove('text-gray-500');
    event.currentTarget.classList.add('iub-blue-text');
    currentMateriaGallery = null;
}

function renderModulesDropdown() {
    materiaSelect.innerHTML = '<option value="">Selecciona...</option>';
    let selectedCuatri = cuatrimestreInput.value;
    localData.modules.forEach(mod => {
        if(mod.cuatrimestre.toString() === selectedCuatri) {
            const opt = document.createElement('option');
            opt.value = mod.nombre; opt.textContent = mod.nombre; materiaSelect.appendChild(opt);
        }
    });
}

function renderModulesGrid() {
    modulosGrid.innerHTML = '';
    localData.modules.forEach(mod => {
        const count = localData.records.filter(r => r.materia === mod.nombre).length;
        const div = document.createElement('div');
        div.className = "bg-white p-4 rounded shadow flex justify-between items-center border-l-4 border-blue-800 cursor-pointer";
        div.innerHTML = `<div><h3 class="font-bold text-gray-800">${mod.nombre} <span class="text-xs font-normal text-gray-400">(Q${mod.cuatrimestre})</span></h3><p class="text-xs text-gray-500">${count} items</p></div><span class="text-blue-800">➔</span>`;
        div.onclick = () => openGallery(mod.nombre);
        modulosGrid.appendChild(div);
    });
}

function openGallery(materia) {
    currentMateriaGallery = materia; galeriaTitulo.textContent = materia; galeriaGrid.innerHTML = '';
    const records = localData.records.filter(r => r.materia === materia);

    records.forEach(r => {
        const div = document.createElement('div');
        div.className = "aspect-square bg-gray-200 rounded overflow-hidden shadow-sm cursor-pointer relative";
        
        if (r.url) {
            div.innerHTML = `<img src="${r.url}" class="w-full h-full object-cover" loading="lazy">
                             <div class="absolute bottom-0 bg-black bg-opacity-60 w-full text-white text-[10px] text-center py-1">${r.fecha.substring(5)}</div>`;
        } else {
            div.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-gray-100 p-2 text-xs text-center">${r.nota.substring(0,25)}</div>`;
        }
        div.onclick = () => showModal(r);
        galeriaGrid.appendChild(div);
    });
    switchTab('tabGaleria', 'Galería');
}

btnVolverModulos.addEventListener('click', () => switchTab('tabModulos', 'Gestor de Módulos'));

function showModal(record) {
    currentRecordId = record.id; modalDate.textContent = `${record.fecha} - ${record.tipo}`;
    fullImage.src = record.url || ""; fullImage.style.display = record.url ? "block" : "none";
    modalNote.textContent = record.nota || "Sin apuntes."; modalNote.style.display = record.nota ? "block" : "none";
    btnDownload.style.display = record.url ? "flex" : "none"; btnShare.style.display = record.url ? "flex" : "none";
    imageModal.classList.remove('hide');
}

btnCloseModal.addEventListener('click', () => { imageModal.classList.add('hide'); fullImage.src = ""; currentRecordId = null; });

function swapRecords(direction) {
    if(!currentRecordId || !currentMateriaGallery) return;
    let subjectRecords = localData.records.filter(r => r.materia === currentMateriaGallery);
    let subjectIndex = subjectRecords.findIndex(r => r.id === currentRecordId);
    if(subjectIndex < 0) return;
    let targetSubjectIndex = subjectIndex + direction;
    if(targetSubjectIndex < 0 || targetSubjectIndex >= subjectRecords.length) return;
    
    let targetRecordId = subjectRecords[targetSubjectIndex].id;
    let globalIndex1 = localData.records.findIndex(r => r.id === currentRecordId);
    let globalIndex2 = localData.records.findIndex(r => r.id === targetRecordId);
    
    let temp = localData.records[globalIndex1]; localData.records[globalIndex1] = localData.records[globalIndex2]; localData.records[globalIndex2] = temp;
    localStorage.setItem('iubVaultData', JSON.stringify(localData)); openGallery(currentMateriaGallery);
}

btnMoveLeft.addEventListener('click', () => swapRecords(-1));
btnMoveRight.addEventListener('click', () => swapRecords(1));

btnDelete.addEventListener('click', async () => {
    if(!currentRecordId) return;
    if(!confirm("¿Eliminar definitivamente de la app y Google Drive?")) return;
    
    const record = localData.records.find(r => r.id === currentRecordId);
    let driveId = null; if(record.url && record.url.includes('/d/')) driveId = record.url.split('/d/')[1];

    btnDelete.textContent = "⏳...";
    try {
        const response = await fetch(GAS_URL, { 
            method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, 
            body: JSON.stringify({ action: "delete", pin: sessionPin, idRegistro: currentRecordId, fileId: driveId }) 
        });
        const result = await response.json();
        
        if (result.status === "success") {
            localData.records = localData.records.filter(r => r.id !== currentRecordId);
            localStorage.setItem('iubVaultData', JSON.stringify(localData));
            imageModal.classList.add('hide'); openGallery(currentMateriaGallery); renderModulesGrid();
        } else { alert("Error al eliminar."); }
    } catch (error) { alert("Error de red."); } finally { btnDelete.innerHTML = `<span class="text-xl mb-1">🗑️</span>Eliminar`; }
});

btnShare.addEventListener('click', async () => {
    const record = localData.records.find(r => r.id === currentRecordId);
    if (!record || !record.url) return;
    if (navigator.share) {
        try { await navigator.share({ title: 'Apunte: ' + record.materia, text: record.nota || 'Imagen de clase', url: record.url }); } catch (e) {}
    } else { alert("Tu navegador no soporta compartir nativamente."); }
});

btnDownload.addEventListener('click', () => {
    const record = localData.records.find(r => r.id === currentRecordId);
    if (record && record.url) { window.open(record.url, '_blank'); }
});

modoSelect.addEventListener('change', (e) => {
    if (e.target.value === 'FOTO') {
        panelFoto.classList.remove('hidden'); panelSpen.classList.add('hidden');
    } else {
        panelFoto.classList.add('hidden'); panelSpen.classList.remove('hidden'); initCanvas();
    }
});

cameraInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(event) {
            fotoBase64 = event.target.result; imagePreview.src = fotoBase64;
            previewContainer.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
});

function initCanvas() {
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0033A0';
}
initCanvas();
btnLimpiarCanvas.addEventListener('click', initCanvas);

canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return; 
    isDrawing = true; const rect = canvas.getBoundingClientRect();
    ctx.beginPath(); ctx.moveTo((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height)); e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || e.pointerType !== 'pen') return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height)); ctx.stroke(); e.preventDefault();
});
canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'pen') return; isDrawing = false; ctx.closePath(); e.preventDefault();
});

// INTERFAZ OPTIMISTA (VELOCIDAD EXTREMA)
btnGuardar.addEventListener('click', async () => {
    const cuatrimestre = cuatrimestreInput.value;
    const materia = materiaSelect.value;
    const textoNota = document.getElementById('textoNota').value;
    const modo = modoSelect.value;
    
    if (!materia) { alert("Selecciona una materia."); return; }

    let payloadImage = null;
    if (modo === 'FOTO') {
        if (!fotoBase64 && !textoNota) { alert("Captura algo."); return; }
        payloadImage = fotoBase64;
    } else {
        payloadImage = canvas.toDataURL("image/png");
    }

    const payload = {
        action: "save", pin: sessionPin, cuatrimestre: cuatrimestre,
        materia: materia, tipo: modo, textoNota: textoNota, imagenBase64: payloadImage
    };

    // 1. Enviar a base de datos interna local instantáneamente
    await addToQueue(payload);
    
    // 2. Limpiar pantalla en milisegundos para permitir siguiente foto
    resetForm();
    statusMessage.textContent = "⚡ Captura en cola..."; 
    statusMessage.className = "text-center text-xs font-bold py-1 text-gray-500 block";
    statusMessage.classList.remove('hidden');
    setTimeout(() => { statusMessage.classList.add('hidden'); }, 1500);
    
    // 3. Activar proceso en segundo plano (no bloquea la UI)
    updateQueueBadge();
    processQueue();
});

btnAgregarMateria.addEventListener('click', async () => {
    const nombre = nuevaMateriaInput.value.trim();
    const cuatri = nuevoCuatrimestreInput.value;
    if (!nombre) return;
    
    ajustesStatus.textContent = "Agregando..."; ajustesStatus.className = "text-center text-sm font-bold py-2 text-blue-600 block";
    btnAgregarMateria.disabled = true;

    try {
        const response = await fetch(GAS_URL, { 
            method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, 
            body: JSON.stringify({ action: "add_module", pin: sessionPin, nombreMateria: nombre, cuatrimestreConfig: cuatri }) 
        });
        const result = await response.json();
        
        if (result.status === "success") {
            ajustesStatus.textContent = "✅ Agregada"; ajustesStatus.className = "text-center text-sm font-bold py-2 text-green-600 block";
            localData.modules.push(result.newModule);
            localStorage.setItem('iubVaultData', JSON.stringify(localData));
            renderModulesDropdown(); renderModulesGrid(); nuevaMateriaInput.value = "";
            setTimeout(() => { ajustesStatus.classList.add('hidden'); }, 2000);
        }
    } catch (e) { ajustesStatus.textContent = "❌ Error"; ajustesStatus.className = "text-center text-sm font-bold py-2 text-red-600 block"; } finally { btnAgregarMateria.disabled = false; }
});

btnLimpiarCache.addEventListener('click', () => {
    localStorage.removeItem('iubVaultData'); sessionStorage.removeItem('iubVaultPin'); location.reload();
});

function resetForm() {
    document.getElementById('textoNota').value = ""; fotoBase64 = null; imagePreview.src = "";
    previewContainer.classList.add('hidden'); initCanvas();
}

initApp();
