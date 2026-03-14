// CONFIGURACIÓN: Reemplaza con tu URL
const GAS_URL = "https://script.google.com/macros/s/AKfycbyPIv-c9UqYflEdfiX1aCoCSHnNOz0qCGcXRkH8wxaRZd-c4bHYPOh0qbfkSJ5-Oij-/exec";



const loginScreen = document.getElementById('loginScreen');
const pinInput = document.getElementById('pinInput');
const btnLogin = document.getElementById('btnLogin');
const loginError = document.getElementById('loginError');

const headerTitle = document.getElementById('headerTitle');
const btnSync = document.getElementById('btnSync');

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

let sessionPin = sessionStorage.getItem('iubVaultPin') || "";
let localData = { modules: [], records: [] };
let isDrawing = false;
let fotoBase64 = null;

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
        validarPinRequest(sessionPin, true);
    } else {
        loginScreen.classList.remove('hide');
    }
}

async function validarPinRequest(pin, isSilent = false) {
    if (!isSilent) {
        btnLogin.textContent = "Verificando...";
        btnLogin.disabled = true;
    }
    try {
        const res = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "sync", pin: pin })
        });
        const result = await res.json();
        if (result.status === "success") {
            sessionPin = pin;
            sessionStorage.setItem('iubVaultPin', pin);
            localData.modules = result.modules || [];
            localData.records = result.records || [];
            localStorage.setItem('iubVaultData', JSON.stringify(localData));
            loginScreen.classList.add('hide');
            renderModulesDropdown();
            renderModulesGrid();
            loginError.classList.add('hide');
        } else {
            throw new Error(result.message);
        }
    } catch (e) {
        if (!isSilent) {
            loginError.textContent = "Error: " + e.message;
            loginError.classList.remove('hide');
            pinInput.value = "";
        } else {
            sessionStorage.removeItem('iubVaultPin');
            loginScreen.classList.remove('hide');
        }
    } finally {
        if (!isSilent) {
            btnLogin.textContent = "Desbloquear";
            btnLogin.disabled = false;
        }
    }
}

btnLogin.addEventListener('click', () => {
    const pin = pinInput.value.trim();
    if (pin.length < 4) return;
    validarPinRequest(pin, false);
});

btnSync.addEventListener('click', async () => {
    if (!sessionPin) return;
    btnSync.textContent = "↻...";
    await validarPinRequest(sessionPin, true);
    btnSync.textContent = "↻ Sync";
});

function switchTab(tabId, title) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    headerTitle.textContent = title;
    navBtns.forEach(btn => {
        btn.classList.remove('iub-blue-text');
        btn.classList.add('text-gray-500');
    });
    event.currentTarget.classList.remove('text-gray-500');
    event.currentTarget.classList.add('iub-blue-text');
}

function renderModulesDropdown() {
    materiaSelect.innerHTML = '<option value="">Selecciona...</option>';
    let selectedCuatri = cuatrimestreInput.value;
    
    localData.modules.forEach(mod => {
        if(mod.cuatrimestre.toString() === selectedCuatri) {
            const opt = document.createElement('option');
            opt.value = mod.nombre;
            opt.textContent = mod.nombre;
            materiaSelect.appendChild(opt);
        }
    });
}

function renderModulesGrid() {
    modulosGrid.innerHTML = '';
    localData.modules.forEach(mod => {
        const count = localData.records.filter(r => r.materia === mod.nombre).length;
        const div = document.createElement('div');
        div.className = "bg-white p-4 rounded shadow flex justify-between items-center border-l-4 border-blue-800 cursor-pointer";
        div.innerHTML = `<div><h3 class="font-bold text-gray-800">${mod.nombre} <span class="text-xs font-normal text-gray-400">(Cuatri ${mod.cuatrimestre})</span></h3><p class="text-xs text-gray-500">${count} documentos</p></div><span class="text-blue-800">➔</span>`;
        div.onclick = () => openGallery(mod.nombre);
        modulosGrid.appendChild(div);
    });
}

function openGallery(materia) {
    galeriaTitulo.textContent = materia;
    galeriaGrid.innerHTML = '';
    const records = localData.records.filter(r => r.materia === materia).reverse();

    records.forEach(r => {
        const div = document.createElement('div');
        div.className = "aspect-square bg-gray-200 rounded overflow-hidden shadow-sm cursor-pointer relative";
        
        if (r.url) {
            div.innerHTML = `<img src="${r.url}" class="w-full h-full object-cover" loading="lazy">
                             <div class="absolute bottom-0 bg-black bg-opacity-60 w-full text-white text-[10px] text-center py-1">${r.fecha}</div>`;
        } else {
            div.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-gray-100 p-2 text-xs text-center">${r.nota.substring(0,30)}...</div>`;
        }
        div.onclick = () => showModal(r);
        galeriaGrid.appendChild(div);
    });
    switchTab('tabGaleria', 'Galería');
}

btnVolverModulos.addEventListener('click', () => switchTab('tabModulos', 'Gestor de Módulos'));

function showModal(record) {
    modalDate.textContent = `${record.fecha} - ${record.tipo}`;
    fullImage.src = record.url || "";
    fullImage.style.display = record.url ? "block" : "none";
    modalNote.textContent = record.nota || "Sin apuntes.";
    modalNote.style.display = record.nota ? "block" : "none";
    imageModal.classList.remove('hide');
}

btnCloseModal.addEventListener('click', () => {
    imageModal.classList.add('hide');
    fullImage.src = "";
});

modoSelect.addEventListener('change', (e) => {
    if (e.target.value === 'FOTO') {
        panelFoto.classList.remove('hidden');
        panelSpen.classList.add('hidden');
    } else {
        panelFoto.classList.add('hidden');
        panelSpen.classList.remove('hidden');
        initCanvas();
    }
});

cameraInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(event) {
            fotoBase64 = event.target.result;
            imagePreview.src = fotoBase64;
            previewContainer.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
});

function initCanvas() {
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0033A0';
}
initCanvas();

btnLimpiarCanvas.addEventListener('click', initCanvas);

canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return; 
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height));
    e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || e.pointerType !== 'pen') return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height));
    ctx.stroke();
    e.preventDefault();
});

canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'pen') return;
    isDrawing = false;
    ctx.closePath();
    e.preventDefault();
});

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

    setStatus(statusMessage, "Guardando...", "blue");
    btnGuardar.disabled = true;

    try {
        const response = await fetch(GAS_URL, { 
            method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) 
        });
        const result = await response.json();
        if (result.status === "success") {
            setStatus(statusMessage, "✅ Guardado", "green");
            localData.records.push({
                id: result.id, fecha: result.fecha, cuatrimestre: cuatrimestre,
                materia: materia, tipo: modo, url: result.url, nota: textoNota
            });
            localStorage.setItem('iubVaultData', JSON.stringify(localData));
            renderModulesGrid();
            setTimeout(() => resetForm(), 1500);
        } else {
            setStatus(statusMessage, "❌ Error", "red");
        }
    } catch (error) {
        setStatus(statusMessage, "❌ Error de red", "red");
    } finally {
        btnGuardar.disabled = false;
    }
});

btnAgregarMateria.addEventListener('click', async () => {
    const nombre = nuevaMateriaInput.value.trim();
    const cuatri = nuevoCuatrimestreInput.value;
    if (!nombre) return;
    
    setStatus(ajustesStatus, "Agregando...", "blue");
    btnAgregarMateria.disabled = true;

    try {
        const response = await fetch(GAS_URL, { 
            method: 'POST', headers: { "Content-Type": "text/plain;charset=utf-8" }, 
            body: JSON.stringify({ action: "add_module", pin: sessionPin, nombreMateria: nombre, cuatrimestreConfig: cuatri }) 
        });
        const result = await response.json();
        
        if (result.status === "success") {
            setStatus(ajustesStatus, "✅ Agregada", "green");
            localData.modules.push(result.newModule);
            localStorage.setItem('iubVaultData', JSON.stringify(localData));
            renderModulesDropdown();
            renderModulesGrid();
            nuevaMateriaInput.value = "";
            setTimeout(() => { ajustesStatus.classList.add('hidden'); }, 2000);
        }
    } catch (e) {
        setStatus(ajustesStatus, "❌ Error", "red");
    } finally {
        btnAgregarMateria.disabled = false;
    }
});

btnLimpiarCache.addEventListener('click', () => {
    localStorage.removeItem('iubVaultData');
    sessionStorage.removeItem('iubVaultPin');
    location.reload();
});

function setStatus(element, msg, color) {
    element.textContent = msg;
    element.className = `text-center text-sm font-bold py-2 text-${color}-600 block`;
}

function resetForm() {
    document.getElementById('textoNota').value = "";
    fotoBase64 = null;
    imagePreview.src = "";
    previewContainer.classList.add('hidden');
    initCanvas();
    setStatus(statusMessage, "", "transparent");
    statusMessage.classList.add("hidden");
}

initApp();
