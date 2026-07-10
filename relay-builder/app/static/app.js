/* GPSA Relay Builder — client UX. Mirrors publicity-intake: drag-drop dropzone,
   async submit, result banner. Loaded on every page, so each block guards on the
   elements it needs. No inline handlers. */

// Generic confirm-on-submit for any form marked with data-confirm.
document.querySelectorAll('form[data-confirm]').forEach((f) =>
    f.addEventListener('submit', (e) => {
        if (!window.confirm(f.dataset.confirm)) e.preventDefault();
    }),
);

// --- Import dropzone (pool page only) ---
const fileDropzone = document.getElementById('file-dropzone');
if (fileDropzone) {
    const ALLOWED = ['.sd3', '.hy3', '.zip'];
    const form = document.getElementById('import-form');
    const fileInput = document.getElementById('file-upload');
    const fileNameLabel = document.getElementById('file-name');
    const filePrompt = document.getElementById('file-prompt');
    const fileIconEmpty = document.getElementById('file-icon-empty');
    const fileIconSelected = document.getElementById('file-icon-selected');
    const fileError = document.getElementById('file-error');
    const submitButton = document.getElementById('submit-button');
    const result = document.getElementById('result');

    const DROPZONE_EMPTY = ['border-gray-300', 'bg-gray-50', 'hover:bg-gray-100'];
    const DROPZONE_SELECTED = ['border-green-500', 'bg-green-50', 'hover:bg-green-100'];

    const escapeHtml = (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };
    const extOf = (name) => name.toLowerCase().slice(name.lastIndexOf('.'));
    const showFieldError = (el, msg) => {
        el.textContent = msg;
        el.classList.toggle('hidden', !msg);
    };
    const showResult = (kind, msg) => {
        result.className = 'mt-6 p-4 rounded-lg text-sm border';
        result.classList.add(
            ...(kind === 'success'
                ? ['bg-green-50', 'text-green-800', 'border-green-200']
                : ['bg-red-50', 'text-red-800', 'border-red-200']),
        );
        result.innerHTML = msg;
        result.classList.remove('hidden');
    };
    const formatBytes = (b) =>
        b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;

    function setFilesSelected(files) {
        fileDropzone.classList.remove(...DROPZONE_EMPTY);
        fileDropzone.classList.add(...DROPZONE_SELECTED);
        fileDropzone.classList.replace('border-dashed', 'border-solid');
        fileIconEmpty.classList.add('hidden');
        fileIconSelected.classList.remove('hidden');
        const n = files.length;
        filePrompt.innerHTML = `<span class="font-semibold text-green-700">${n} file${n === 1 ? '' : 's'} attached</span> — click to choose different files`;
        const total = Array.from(files).reduce((a, f) => a + f.size, 0);
        fileNameLabel.textContent = `${n === 1 ? files[0].name : n + ' files'} (${formatBytes(total)})`;
        fileNameLabel.classList.remove('text-gray-500');
        fileNameLabel.classList.add('text-green-700', 'font-medium');
    }

    function setFilesEmpty() {
        fileDropzone.classList.remove(...DROPZONE_SELECTED);
        fileDropzone.classList.add(...DROPZONE_EMPTY);
        fileDropzone.classList.replace('border-solid', 'border-dashed');
        fileIconSelected.classList.add('hidden');
        fileIconEmpty.classList.remove('hidden');
        filePrompt.innerHTML = '<span class="font-semibold">Click to choose files</span> or drag them here';
        fileNameLabel.textContent = 'Accepted: .sd3, .hy3, or .zip · multiple allowed';
        fileNameLabel.classList.remove('text-green-700', 'font-medium');
        fileNameLabel.classList.add('text-gray-500');
    }

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            setFilesSelected(fileInput.files);
            showFieldError(fileError, '');
        } else {
            setFilesEmpty();
        }
    });

    ['dragenter', 'dragover'].forEach((ev) =>
        fileDropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            fileDropzone.classList.add('bg-gray-100');
        }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
        fileDropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            fileDropzone.classList.remove('bg-gray-100');
        }),
    );
    fileDropzone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            fileInput.dispatchEvent(new Event('change'));
        }
    });

    function validate() {
        const files = fileInput.files;
        if (!files.length) {
            showFieldError(fileError, 'Please choose at least one file.');
            return false;
        }
        for (const f of files) {
            if (!ALLOWED.includes(extOf(f.name))) {
                showFieldError(fileError, 'Files must be .sd3, .hy3, or .zip.');
                return false;
            }
        }
        showFieldError(fileError, '');
        return true;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        result.classList.add('hidden');
        if (!validate()) return;

        const data = new FormData();
        for (const f of fileInput.files) data.append('files', f);

        submitButton.disabled = true;
        const originalLabel = submitButton.textContent;
        submitButton.textContent = 'Importing…';

        try {
            const res = await fetch('/import', { method: 'POST', body: data });
            let payload = {};
            try { payload = await res.json(); } catch { /* non-JSON error body */ }

            if (res.ok && payload.success) {
                const rows = payload.imported || [];
                const ok = rows.filter((r) => !r.error);
                const bad = rows.filter((r) => r.error);
                const swimmers = ok.reduce((a, r) => a + (r.swimmers || 0), 0);
                let msg = `Imported ${ok.length} file${ok.length === 1 ? '' : 's'} · ${swimmers} swimmer${swimmers === 1 ? '' : 's'}.`;
                if (bad.length) msg += ` ${bad.length} skipped (unparseable).`;
                showResult('success', escapeHtml(msg));
                setTimeout(() => window.location.reload(), 700);
            } else {
                showResult('error', escapeHtml(payload.error || `Import failed (status ${res.status}).`));
                submitButton.disabled = false;
                submitButton.textContent = originalLabel;
            }
        } catch {
            showResult('error', 'Network error — could not reach the server. Try again.');
            submitButton.disabled = false;
            submitButton.textContent = originalLabel;
        }
    });
}

// --- Reset pool (pool page only) ---
const resetForm = document.getElementById('reset-form');
if (resetForm) {
    resetForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!window.confirm('Clear all imported swimmers?')) return;
        await fetch('/reset', { method: 'POST' });
        window.location.reload();
    });
}
