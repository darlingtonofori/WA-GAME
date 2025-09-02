const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const pino = require('pino');

// Initialize web server
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// Store pairing requests
const pairingRequests = new Map();

// Web routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pairing.html'));
});

app.post('/api/request-pairing', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) {
            return res.json({ success: false, error: 'Phone number required' });
        }

        // Clean the number
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        // Basic validation
        if (cleanNumber.length < 8 || cleanNumber.length > 15) {
            return res.json({ success: false, error: 'Invalid phone number length' });
        }

        // Store the number for processing
        pairingRequests.set(cleanNumber, { status: 'pending', timestamp: Date.now() });
        io.emit('number-submitted', { number: cleanNumber, status: 'pending' });
        
        res.json({ success: true, message: 'Number received, pairing code will be generated shortly', number: cleanNumber });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
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

// WhatsApp Bot with legitimate pairing
async function startWhatsAppBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        browser: ["Chrome", "Linux", ""]
    });

    // Handle pairing code requests
    setInterval(async () => {
        for (const [number, data] of pairingRequests.entries()) {
            if (data.status === 'pending') {
                try {
                    console.log(`Processing pairing request for: ${number}`);
                    
                    // Request legitimate pairing code from WhatsApp
                    const pairingCode = await sock.requestPairingCode(number.replace(/[^0-9]/g, ''));
                    
                    // Format the code for display (XXXX-XXXX format)
                    const formattedCode = typeof pairingCode === 'string' 
                        ? pairingCode.match(/.{1,4}/g).join('-')
                        : pairingCode.pairingCode.match(/.{1,4}/g).join('-');
                    
                    console.log(`Pairing code for ${number}: ${formattedCode}`);
                    
                    // Update status and emit to clients
                    pairingRequests.set(number, { 
                        status: 'generated', 
                        code: formattedCode, 
                        timestamp: Date.now() 
                    });
                    
                    io.emit('pairing-code-generated', { 
                        number, 
                        code: formattedCode 
                    });
                    
                } catch (error) {
                    console.error(`Error getting pairing code for ${number}:`, error);
                    pairingRequests.set(number, { 
                        status: 'error', 
                        error: error.message,
                        timestamp: Date.now() 
                    });
                    
                    io.emit('pairing-error', { 
                        number, 
                        error: error.message 
                    });
                }
            }
        }
    }, 3000);

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                startWhatsAppBot();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened successfully');
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
                text: `🤖 WhatsApp Bot\n\nThis bot uses legitimate WhatsApp pairing codes, not QR codes.` 
            });
        }
    });

    return sock;
}

// Start the bot
startWhatsAppBot().catch(err => {
    console.error('Failed to start bot:', err);
});
