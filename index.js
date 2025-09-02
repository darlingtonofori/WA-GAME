const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

// Initialize web server
const app = express();
const server = http.createServer(app);

app.use(express.static('public'));
app.use(express.json());

// Store pairing codes
const pairingCodes = new Map();

// Web routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pairing.html'));
});

app.get('/api/pairing-code', (req, res) => {
    const { code, number } = req.query;
    if (code && number) {
        pairingCodes.set(code, { number, timestamp: Date.now() });
        res.json({ success: true, code, number });
    } else {
        res.json({ success: false, error: 'Missing parameters' });
    }
});

// Health check endpoint for Render
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Use Render's PORT or default to 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// WhatsApp Bot with proper pairing
async function startWhatsAppBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        // Essential settings for proper functionality
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        browser: ["Chrome", "Linux", ""]
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Code received, ready for pairing');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startWhatsAppBot();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened successfully');
        }
    });

    // Handle pairing code requests
    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        if (connection === 'open') {
            console.log('Successfully connected to WhatsApp');
        }
    });

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message.message) return;
        
        const text = message.message.conversation || 
                    (message.message.extendedTextMessage && message.message.extendedTextMessage.text) || 
                    '';
        
        const jid = message.key.remoteJid;
        
        if (text.toLowerCase() === '.ping') {
            await sock.sendMessage(jid, { text: 'Pong! 🏓' });
        }
        
        if (text.toLowerCase() === '.info') {
            await sock.sendMessage(jid, { 
                text: `🤖 WhatsApp Bot\n\nThis bot is powered by Baileys library with legitimate WhatsApp pairing.` 
            });
        }
    });

    return sock;
}

// Start the bot
startWhatsAppBot().catch(err => {
    console.error('Failed to start bot:', err);
});
