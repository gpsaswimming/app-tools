/* GPSA Publicity Intake — client-side form logic.
   No inline handlers (keeps script-src 'self'). */

const ALLOWED_EXTENSIONS = ['.sd3', '.zip'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const form = document.getElementById('submit-form');
const emailInput = document.getElementById('email');
const fileInput = document.getElementById('file-upload');
const fileNameLabel = document.getElementById('file-name');
const filePrompt = document.getElementById('file-prompt');
const fileDropzone = document.getElementById('file-dropzone');
const fileIconEmpty = document.getElementById('file-icon-empty');
const fileIconSelected = document.getElementById('file-icon-selected');
const emailError = document.getElementById('email-error');
const fileError = document.getElementById('file-error');
const submitButton = document.getElementById('submit-button');
const result = document.getElementById('result');

// Dropzone styling for each state, so we can cleanly toggle between them.
const DROPZONE_EMPTY = ['border-gray-300', 'bg-gray-50', 'hover:bg-gray-100'];
const DROPZONE_SELECTED = ['border-green-500', 'bg-green-50', 'hover:bg-green-100'];

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function extOf(name) {
    return name.toLowerCase().slice(name.lastIndexOf('.'));
}

function showFieldError(el, msg) {
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
}

function showResult(kind, msg) {
    result.className = 'mt-6 p-4 rounded-lg text-sm border';
    if (kind === 'success') {
        result.classList.add('bg-green-50', 'text-green-800', 'border-green-200');
    } else {
        result.classList.add('bg-red-50', 'text-red-800', 'border-red-200');
    }
    result.innerHTML = escapeHtml(msg);
    result.classList.remove('hidden');
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Flip the dropzone into its "file attached" state (green, checkmark, filename).
function setFileSelected(file) {
    fileDropzone.classList.remove(...DROPZONE_EMPTY);
    fileDropzone.classList.add(...DROPZONE_SELECTED);
    fileDropzone.classList.replace('border-dashed', 'border-solid');
    fileIconEmpty.classList.add('hidden');
    fileIconSelected.classList.remove('hidden');
    filePrompt.innerHTML = '<span class="font-semibold text-green-700">File attached</span> — click to choose a different file';
    fileNameLabel.textContent = `${file.name} (${formatBytes(file.size)})`;
    fileNameLabel.classList.remove('text-gray-500');
    fileNameLabel.classList.add('text-green-700', 'font-medium');
}

// Restore the dropzone's empty state.
function setFileEmpty() {
    fileDropzone.classList.remove(...DROPZONE_SELECTED);
    fileDropzone.classList.add(...DROPZONE_EMPTY);
    fileDropzone.classList.replace('border-solid', 'border-dashed');
    fileIconSelected.classList.add('hidden');
    fileIconEmpty.classList.remove('hidden');
    filePrompt.innerHTML = '<span class="font-semibold">Click to choose a file</span> or drag it here';
    fileNameLabel.textContent = 'Accepted: .sd3 or .zip';
    fileNameLabel.classList.remove('text-green-700', 'font-medium');
    fileNameLabel.classList.add('text-gray-500');
}

// Reflect the chosen filename in the dropzone label.
fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) {
        setFileSelected(file);
        showFieldError(fileError, '');
    } else {
        setFileEmpty();
    }
});

emailInput.addEventListener('input', () => showFieldError(emailError, ''));

function validate() {
    let ok = true;

    const email = emailInput.value.trim();
    if (!EMAIL_RE.test(email)) {
        showFieldError(emailError, 'Please enter a valid email address.');
        ok = false;
    } else {
        showFieldError(emailError, '');
    }

    const file = fileInput.files[0];
    if (!file) {
        showFieldError(fileError, 'Please choose a results file.');
        ok = false;
    } else if (!ALLOWED_EXTENSIONS.includes(extOf(file.name))) {
        showFieldError(fileError, 'File must be a .sd3 or .zip.');
        ok = false;
    } else {
        showFieldError(fileError, '');
    }

    return ok;
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    result.classList.add('hidden');

    if (!validate()) return;

    const data = new FormData();
    data.append('email', emailInput.value.trim());
    data.append('file', fileInput.files[0]);

    submitButton.disabled = true;
    const originalLabel = submitButton.textContent;
    submitButton.textContent = 'Submitting…';

    try {
        const res = await fetch('/submit', { method: 'POST', body: data });
        let payload = {};
        try { payload = await res.json(); } catch { /* non-JSON error body */ }

        if (res.ok && payload.success) {
            showResult('success', payload.message || 'Results submitted successfully. Thank you!');
            form.reset();
            setFileEmpty();
        } else {
            showResult('error', payload.error || `Submission failed (status ${res.status}). Please try again.`);
        }
    } catch {
        showResult('error', 'Network error — could not reach the server. Check your connection and try again.');
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
    }
});
