/**
 * Shared file-upload dropzone UX for the browser tools, matching the
 * publicity-intake form: a dashed dropzone with a document icon that flips to a
 * green "File attached" state (checkmark + filename + size) on selection, plus
 * working drag-and-drop.
 *
 * Used by entry-summary.html and entry-fees-report.html.
 */

const EMPTY = ['border-gray-300', 'bg-gray-50', 'hover:bg-gray-100'];
const SELECTED = ['border-green-500', 'bg-green-50', 'hover:bg-green-100'];
const DRAG = ['border-blue-500', 'bg-blue-50'];

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Wires a dropzone <label> + hidden file <input>.
 *
 * @param {object} o
 * @param {HTMLElement} o.dropzone      the <label> dropzone
 * @param {HTMLInputElement} o.input     the hidden file input
 * @param {HTMLElement} o.prompt         the prompt line
 * @param {HTMLElement} o.nameLabel      the filename/accepted line
 * @param {HTMLElement} [o.iconEmpty]    document icon (empty state)
 * @param {HTMLElement} [o.iconSelected] check icon (selected state)
 * @param {string} o.accepted            e.g. 'Accepted: .sd3 or .zip'
 * @param {(file: File) => void} o.onFile called when a file is chosen
 * @returns {{ reset: () => void }}
 */
export function wireDropzone({ dropzone, input, prompt, nameLabel, iconEmpty, iconSelected, accepted, onFile }) {
    function setSelected(file) {
        dropzone.classList.remove(...EMPTY, ...DRAG);
        dropzone.classList.add(...SELECTED);
        dropzone.classList.replace('border-dashed', 'border-solid');
        iconEmpty?.classList.add('hidden');
        iconSelected?.classList.remove('hidden');
        prompt.innerHTML = '<span class="font-semibold text-green-700">File attached</span> — click to choose a different file';
        nameLabel.textContent = `${file.name} (${formatBytes(file.size)})`;
        nameLabel.classList.remove('text-gray-400', 'text-gray-500');
        nameLabel.classList.add('text-green-700', 'font-medium');
    }

    function setEmpty() {
        dropzone.classList.remove(...SELECTED, ...DRAG);
        dropzone.classList.add(...EMPTY);
        dropzone.classList.replace('border-solid', 'border-dashed');
        iconSelected?.classList.add('hidden');
        iconEmpty?.classList.remove('hidden');
        prompt.innerHTML = '<span class="font-semibold">Click to choose a file</span> or drag it here';
        nameLabel.textContent = accepted;
        nameLabel.classList.remove('text-green-700', 'font-medium');
        nameLabel.classList.add('text-gray-500');
    }

    function handle(file) {
        if (!file) { setEmpty(); return; }
        setSelected(file);
        onFile(file);
    }

    input.addEventListener('change', () => handle(input.files[0]));

    ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.add(...DRAG);
    }));
    ['dragleave', 'dragend'].forEach((ev) => dropzone.addEventListener(ev, () => dropzone.classList.remove(...DRAG)));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file) { dropzone.classList.remove(...DRAG); return; }
        input.files = e.dataTransfer.files; // reflect the drop into the input
        handle(file);
    });

    return { reset: setEmpty };
}
