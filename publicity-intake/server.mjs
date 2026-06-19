/**
 * GPSA Publicity Intake Form
 *
 * Internal, Pangolin-fronted web form that accepts a submitter email + an SDIF
 * meet-results file (.sd3 or a .zip containing one) and forwards both to the
 * n8n publicity webhook as multipart/form-data.
 *
 * This is the reliable replacement for emailing results in. Authentication is
 * handled upstream by Pangolin; this service trusts that only authenticated
 * traffic reaches it, but still validates and hardens its own surface.
 */

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS || 15000);

// =============================================================================
// Configuration
// =============================================================================

const MAX_FILE_SIZE = 256 * 1024; // 256KB — SDIF dual-meet files are tiny
const ALLOWED_EXTENSIONS = ['.sd3', '.zip'];

// RFC-5322-lite: good enough to reject obvious garbage without false negatives.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extOf(name) {
    return name.toLowerCase().slice(name.lastIndexOf('.'));
}

// Memory storage only — the file is forwarded straight to n8n and never touches
// disk, which removes path-traversal and temp-file cleanup concerns entirely.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1,
        fields: 5
    },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_EXTENSIONS.includes(extOf(file.originalname))) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: .sd3, .zip'));
        }
    }
});

// =============================================================================
// Middleware
// =============================================================================

app.disable('x-powered-by');

// Conservative security headers. The page only loads its own assets plus the
// GPSA brand CDNs (css/assets/fonts), so the CSP is tight.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The form follows the GPSA Tool UI Template: Tailwind Play CDN for layout
    // utilities + the shared GPSA stylesheet for branding. Tailwind's JIT needs
    // 'unsafe-eval'; it also injects a <style> block, hence 'unsafe-inline' for
    // styles. All page logic lives in /app.js (script-src 'self'), not inline.
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'none'",
            "img-src 'self' https://assets.gpsaswimming.org",
            "style-src 'self' 'unsafe-inline' https://css.gpsaswimming.org https://fonts.googleapis.com",
            "font-src https://fonts.gstatic.com",
            "script-src 'self' 'unsafe-eval' https://cdn.tailwindcss.com",
            "connect-src 'self'",
            "form-action 'self'",
            "base-uri 'none'",
            "frame-ancestors 'none'"
        ].join('; ')
    );
    next();
});

// Simple request logging (no bodies — avoids logging submitter PII at rest).
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const status = res.statusCode < 400 ? 'OK' : 'FAIL';
        console.log(
            [new Date().toISOString(), req.method, req.path, status, res.statusCode, `${Date.now() - start}ms`].join(' | ')
        );
    });
    next();
});

// Static form. express.static is path-traversal safe; index.html is served at /.
app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    dotfiles: 'ignore',
    index: 'index.html'
}));

// =============================================================================
// Routes
// =============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        webhookConfigured: Boolean(WEBHOOK_URL),
        timestamp: new Date().toISOString()
    });
});

/**
 * Accept the form submission and forward it to the n8n publicity webhook.
 *
 * Request: multipart/form-data
 *   - email: submitter email (required)
 *   - file:  .sd3 or .zip (required)
 */
app.post('/submit', upload.single('file'), async (req, res) => {
    if (!WEBHOOK_URL) {
        console.error('N8N_WEBHOOK_URL is not configured — refusing submission.');
        return res.status(503).json({ success: false, error: 'Submission endpoint is not configured. Contact the GPSA admin.' });
    }

    const email = (req.body.email || '').trim();
    if (!EMAIL_RE.test(email) || email.length > 254) {
        return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, error: 'A results file (.sd3 or .zip) is required.' });
    }

    // Re-check the extension server-side (defence in depth; multer already filtered).
    if (!ALLOWED_EXTENSIONS.includes(extOf(req.file.originalname))) {
        return res.status(400).json({ success: false, error: 'Invalid file type. Allowed: .sd3, .zip' });
    }

    try {
        const form = new FormData();
        form.append('email', email);
        form.append(
            'file',
            new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }),
            req.file.originalname
        );

        const upstream = await fetch(WEBHOOK_URL, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
        });

        if (!upstream.ok) {
            console.error(`n8n webhook returned ${upstream.status} for file="${req.file.originalname}"`);
            return res.status(502).json({
                success: false,
                error: `The results service rejected the submission (status ${upstream.status}). Please try again or contact the GPSA admin.`
            });
        }

        console.log(`Forwarded to n8n | email="${email}" | file="${req.file.originalname}" | ${req.file.size}B`);
        return res.json({ success: true, message: 'Results submitted successfully. Thank you!' });

    } catch (err) {
        const reason = err.name === 'TimeoutError' || err.name === 'AbortError'
            ? 'The results service did not respond in time.'
            : 'Could not reach the results service.';
        console.error('Webhook forward failed:', err.name, err.message);
        return res.status(502).json({ success: false, error: `${reason} Please try again or contact the GPSA admin.` });
    }
});

// =============================================================================
// Error handling
// =============================================================================

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024}KB.` });
        }
        return res.status(400).json({ success: false, error: error.message });
    }
    if (error?.message === 'Invalid file type. Allowed: .sd3, .zip') {
        return res.status(400).json({ success: false, error: error.message });
    }
    console.error('Unhandled error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found.' });
});

// =============================================================================
// Startup
// =============================================================================

app.listen(PORT, HOST, () => {
    console.log(`GPSA Publicity Intake — listening on http://${HOST}:${PORT}`);
    if (!WEBHOOK_URL) {
        console.warn('WARNING: N8N_WEBHOOK_URL is not set. Submissions will be rejected until it is configured.');
    }
});
