// CONFIGURACIÓN CRÍTICA: Reemplazar con la URL generada al publicar el script en GAS
const GAS_URL = "https://script.google.com/macros/s/AKfycbyPIv-c9UqYflEdfiX1aCoCSHnNOz0qCGcXRkH8wxaRZd-c4bHYPOh0qbfkSJ5-Oij-/exec";

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

let isDrawing = false;
let fotoBase64 = null;

// Lógica de UI - Cambio de Modos
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

// Lógica de Cámara a Base64
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

// Lógica de Canvas con Rechazo de Palma (Strict S-Pen)
function initCanvas() {
    ctx.fillStyle = "white"; // Fondo blanco real en la imagen final, ignorando la grilla CSS
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#000000';
}
initCanvas();

btnLimpiarCanvas.addEventListener('click', initCanvas);

canvas.addEventListener('pointerdown', (e) => {
    // RECHAZO DE PALMA: Solo permite trazos si el hardware detecta el lápiz
    if (e.pointerType !== 'pen') return; 
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    ctx.beginPath();
    ctx.moveTo(x, y);
    e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || e.pointerType !== 'pen') return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    ctx.lineTo(x, y);
    ctx.stroke();
    e.preventDefault();
});

canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'pen') return;
    isDrawing = false;
    ctx.closePath();
    e.preventDefault();
});

// Lógica de Envío al Backend
btnGuardar.addEventListener('click', async () => {
    const cuatrimestre = document.getElementById('cuatrimestreInput').value;
    const materia = document.getElementById('materiaInput').value;
    const textoNota = document.getElementById('textoNota').value;
    const modo = modoSelect.value;
    
    if (!materia) {
        alert("Debes ingresar el nombre de la materia.");
        return;
    }

    let payloadImage = null;

    if (modo === 'FOTO') {
        if (!fotoBase64 && !textoNota) {
            alert("Toma una foto o escribe un apunte.");
            return;
        }
        payloadImage = fotoBase64;
    } else {
        payloadImage = canvas.toDataURL("image/png"); // Extrae PNG con fondo blanco
    }

    const payload = {
        cuatrimestre: cuatrimestre,
        materia: materia,
        tipo: modo,
        textoNota: textoNota,
        imagenBase64: payloadImage
    };

    setStatus("Guardando datos en el servidor...", "blue");
    btnGuardar.disabled = true;

    try {
        const response = await fetch(GAS_URL, {
            method: 'POST',
            body: JSON.stringify(payload) // Sin headers explícitos para evitar preflight CORS estricto en GAS
        });
        
        const result = await response.json();
        
        if (result.status === "success") {
            setStatus("✅ Guardado exitosamente", "green");
            setTimeout(() => resetForm(), 2000);
        } else {
            setStatus("❌ Error: " + result.message, "red");
        }
    } catch (error) {
        setStatus("❌ Error de red o CORS. Verifica la URL de GAS.", "red");
        console.error(error);
    } finally {
        btnGuardar.disabled = false;
    }
});

function setStatus(msg, color) {
    statusMessage.textContent = msg;
    statusMessage.className = `text-center text-sm font-semibold py-2 text-${color}-600 block`;
}

function resetForm() {
    document.getElementById('textoNota').value = "";
    fotoBase64 = null;
    imagePreview.src = "";
    previewContainer.classList.add('hidden');
    initCanvas();
    setStatus("", "transparent");
    statusMessage.classList.add("hidden");
}
