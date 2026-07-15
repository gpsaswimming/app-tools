/* GPSA Publicity Intake — client-side form logic.
   ES module: parses the file in the browser (swimparse + JSZip) so the submitter
   can review the meet date, teams, and score before anything is sent to n8n.
   No inline handlers (keeps script-src 'self'). */

import { parse, score } from '/vendor/swimparse/index.js';

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
const editStage = document.getElementById('edit-stage');
const previewStage = document.getElementById('preview-stage');
const previewBody = document.getElementById('preview-body');
const reviewButton = document.getElementById('review-button');
const confirmButton = document.getElementById('confirm-button');
const backButton = document.getElementById('back-button');
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

// =============================================================================
// Preview: read the SDIF text (unzipping if needed) and summarise the meet.
// =============================================================================

// Return the SDIF text from a .sd3, or from the first .sd3/.txt inside a .zip.
async function readSdifText(file) {
    if (extOf(file.name) !== '.zip') return file.text();

    const zip = await JSZip.loadAsync(file);
    const entry = Object.values(zip.files).find(
        (e) => !e.dir && /\.(sd3|txt)$/i.test(e.name)
    );
    if (!entry) throw new Error('No .sd3 file was found inside the .zip.');
    return entry.async('string');
}

function formatMeetDate(iso) {
    // iso is "YYYY-MM-DD"; build a local date to avoid UTC day-shift.
    const [y, m, d] = (iso || '').split('-').map(Number);
    if (!y || !m || !d) return { text: iso || 'Unknown date', year: null };
    const date = new Date(y, m - 1, d);
    const text = date.toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    return { text, year: y };
}

// Build the preview card from a parsed + scored meet.
function renderMeetPreview(meet) {
    const totals = score(meet);
    const { text: dateText, year } = formatMeetDate(meet.meet.startDate);

    // The bug we're guarding against: a team re-submitting last year's results.
    const isStale = year !== null && year < new Date().getFullYear();
    const staleWarning = isStale
        ? `<div class="mb-3 p-3 rounded-md bg-red-50 border border-red-200 text-red-800 text-sm">
             <span class="font-semibold">Heads up:</span> this meet is dated <span class="font-semibold">${year}</span>,
             not the current season. Make sure you're submitting the right file.
           </div>`
        : '';

    const teamRows = [...meet.teams]
        .map((t) => ({ name: t.name || t.code, points: totals[t.code] || 0 }))
        .sort((a, b) => b.points - a.points)
        .map((t) => `
            <div class="flex items-baseline justify-between py-1">
                <span class="text-gray-800">${escapeHtml(t.name)}</span>
                <span class="font-bold text-gray-900 tabular-nums">${t.points}</span>
            </div>`)
        .join('');

    previewBody.innerHTML = `
        ${staleWarning}
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Meet date</div>
        <div class="text-lg font-bold text-gray-900 mb-3">${escapeHtml(dateText)}</div>
        ${meet.meet.name ? `<div class="text-sm text-gray-600 mb-3">${escapeHtml(meet.meet.name)}</div>` : ''}
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Teams &amp; score</div>
        <div class="divide-y divide-gray-200">${teamRows || '<div class="text-sm text-gray-500 py-1">No teams found.</div>'}</div>
    `;
}

// Shown when the file can't be parsed — don't block a legitimate submission.
function renderUnparsedPreview(file, reason) {
    previewBody.innerHTML = `
        <div class="mb-2 p-3 rounded-md bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm">
            We couldn't read this file to preview it (${escapeHtml(reason)}).
            Double-check it's the correct results file before submitting.
        </div>
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">File</div>
        <div class="text-sm font-medium text-gray-900">${escapeHtml(file.name)} (${formatBytes(file.size)})</div>
    `;
}

function showEditStage() {
    previewStage.classList.add('hidden');
    editStage.classList.remove('hidden');
}

function showPreviewStage() {
    editStage.classList.add('hidden');
    previewStage.classList.remove('hidden');
}

// =============================================================================
// Stage transitions
// =============================================================================

// "Review results →" — validate, parse, and show the preview stage.
form.addEventListener('submit', async (event) => {
    event.preventDefault();
    result.classList.add('hidden');

    if (!validate()) return;

    const file = fileInput.files[0];
    reviewButton.disabled = true;
    const originalLabel = reviewButton.textContent;
    reviewButton.textContent = 'Reading file…';

    try {
        const text = await readSdifText(file);
        renderMeetPreview(parse(text));
    } catch (err) {
        // Parsing is a courtesy check, not a gate — let them proceed with a warning.
        renderUnparsedPreview(file, err.message || 'unrecognised format');
    } finally {
        reviewButton.disabled = false;
        reviewButton.textContent = originalLabel;
    }

    showPreviewStage();
});

backButton.addEventListener('click', () => {
    result.classList.add('hidden');
    showEditStage();
});

// "Confirm & submit" — forward email + file to the server (which proxies to n8n).
confirmButton.addEventListener('click', async () => {
    result.classList.add('hidden');

    const data = new FormData();
    data.append('email', emailInput.value.trim());
    data.append('file', fileInput.files[0]);

    confirmButton.disabled = true;
    const originalLabel = confirmButton.textContent;
    confirmButton.textContent = 'Submitting…';

    try {
        const res = await fetch('/submit', { method: 'POST', body: data });
        let payload = {};
        try { payload = await res.json(); } catch { /* non-JSON error body */ }

        if (res.ok && payload.success) {
            showResult('success', payload.message || 'Results submitted successfully. Thank you!');
            form.reset();
            setFileEmpty();
            showEditStage();
        } else {
            showResult('error', payload.error || `Submission failed (status ${res.status}). Please try again.`);
        }
    } catch {
        showResult('error', 'Network error — could not reach the server. Check your connection and try again.');
    } finally {
        confirmButton.disabled = false;
        confirmButton.textContent = originalLabel;
    }
});
