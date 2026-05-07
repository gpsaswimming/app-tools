/**
 * GPSA Publicity API Server
 *
 * REST API for processing SDIF swim meet results files.
 * Designed for integration with n8n and other automation tools.
 */

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import JSZip from 'jszip';

// Import shared parsing logic
import {
    parseSdif,
    validateSdif,
    validateDualMeet,
    applyForfeitScores,
    generateExportableHtml,
    generateFilename,
    extractMetadata,
    LOGO_URL,
    VERSION
} from './lib/publicity-core.js';

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// Configuration
// =============================================================================

const MAX_FILE_SIZE = 256 * 1024; // 256KB
const ALLOWED_EXTENSIONS = ['.sd3', '.txt', '.zip'];

// Configure multer for memory storage (no temp files)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE
    },
    fileFilter: (req, file, cb) => {
        const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
        if (ALLOWED_EXTENSIONS.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: .sd3, .txt, .zip'));
        }
    }
});

// =============================================================================
// Middleware
// =============================================================================

app.use(cors());
app.use(express.json());

// Simple request logging
app.use((req, res, next) => {
    const start = Date.now();
    const timestamp = new Date().toISOString();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode < 400 ? 'OK' : 'FAIL';
        const logParts = [
            timestamp,
            req.method,
            req.path,
            status,
            res.statusCode,
            `${duration}ms`
        ];

        // Add filename for file uploads
        if (req.file) {
            logParts.push(`file="${req.file.originalname}"`);
        }

        console.log(logParts.join(' | '));
    });

    next();
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extracts SDIF content from a zip file buffer.
 * @param {Buffer} buffer - Zip file buffer
 * @returns {Promise<string|null>} SDIF content or null if not found
 */
async function extractSdifFromZip(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const sdifFiles = [];

    zip.forEach((relativePath, zipEntry) => {
        const fileName = relativePath.toLowerCase();
        if ((fileName.endsWith('.sd3') || fileName.endsWith('.txt')) && !zipEntry.dir) {
            sdifFiles.push({ name: relativePath, entry: zipEntry });
        }
    });

    if (sdifFiles.length === 0) {
        return null;
    }

    // Return the first SDIF file found
    return await sdifFiles[0].entry.async('text');
}

// =============================================================================
// Routes
// =============================================================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: VERSION,
        timestamp: new Date().toISOString()
    });
});

/**
 * API info endpoint
 */
app.get('/api', (req, res) => {
    res.json({
        name: 'GPSA Publicity API',
        version: VERSION,
        endpoints: {
            'GET /health': 'Health check',
            'GET /api': 'API information',
            'POST /api/process': 'Process SDIF file'
        },
        limits: {
            maxFileSize: `${MAX_FILE_SIZE / 1024}KB`,
            allowedExtensions: ALLOWED_EXTENSIONS
        }
    });
});

/**
 * Process SDIF file endpoint
 *
 * Request: multipart/form-data
 *   - file: SDIF file (.sd3, .txt, or .zip)
 *   - override: Optional JSON string with override configuration
 *
 * Response: JSON with success, filename, html, and metadata
 */
app.post('/api/process', upload.single('file'), async (req, res) => {
    try {
        // Validate file was uploaded
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }

        let sdifContent;
        const fileName = req.file.originalname.toLowerCase();

        // Extract SDIF content based on file type
        if (fileName.endsWith('.zip')) {
            sdifContent = await extractSdifFromZip(req.file.buffer);
            if (!sdifContent) {
                return res.status(400).json({
                    success: false,
                    error: 'No SDIF files (.sd3 or .txt) found in zip archive'
                });
            }
        } else {
            sdifContent = req.file.buffer.toString('utf-8');
        }

        // Validate SDIF format
        const validation = validateSdif(sdifContent);
        if (!validation.valid) {
            return res.status(422).json({
                success: false,
                error: validation.error
            });
        }

        // Parse SDIF content
        let parsedData = parseSdif(sdifContent);

        // Validate this is a dual meet (exactly 2 teams)
        const dualMeetValidation = validateDualMeet(parsedData);
        if (!dualMeetValidation.valid) {
            return res.status(422).json({
                success: false,
                error: dualMeetValidation.error
            });
        }

        // Handle override configuration
        let overrideData = null;
        if (req.body.override) {
            try {
                const overrideConfig = typeof req.body.override === 'string'
                    ? JSON.parse(req.body.override)
                    : req.body.override;

                if (overrideConfig.enabled && overrideConfig.winnerCode) {
                    const teams = Object.values(parsedData.teams);
                    const winnerTeam = teams.find(t => t.code === overrideConfig.winnerCode);
                    const loserTeam = teams.find(t => t.code !== overrideConfig.winnerCode);

                    if (winnerTeam && loserTeam) {
                        overrideData = {
                            winnerCode: winnerTeam.code,
                            winnerName: winnerTeam.name,
                            loserCode: loserTeam.code,
                            loserName: loserTeam.name,
                            reason: overrideConfig.reason || 'Override applied'
                        };

                        // Apply forfeit scores
                        parsedData = applyForfeitScores(parsedData, overrideData);
                    }
                }
            } catch (e) {
                // Invalid override JSON, ignore and continue without override
                console.warn('Invalid override configuration:', e.message);
            }
        }

        // Generate output filename
        const outputFilename = generateFilename(parsedData);

        // Generate HTML output
        const html = generateExportableHtml(parsedData, LOGO_URL, overrideData);

        // Extract metadata
        const metadata = extractMetadata(parsedData);

        // Return success response
        res.json({
            success: true,
            filename: outputFilename,
            html: html,
            metadata: metadata
        });

    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// =============================================================================
// Error Handling
// =============================================================================

// Handle multer errors (file size, type)
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024}KB`
            });
        }
        return res.status(400).json({
            success: false,
            error: error.message
        });
    }

    if (error.message === 'Invalid file type. Allowed: .sd3, .txt, .zip') {
        return res.status(400).json({
            success: false,
            error: error.message
        });
    }

    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// =============================================================================
// Server Startup
// =============================================================================

app.listen(PORT, () => {
    console.log(`GPSA Publicity API v${VERSION}`);
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
