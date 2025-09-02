const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const pino = require('pino');
const fs = require('fs-extra');
const { exec } = require("child_process");
const { Boom } = require("@hapi/boom");

// Initialize web server
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// Store pairing requests
const pairingRequests = new Map();
const activePairingRequests = new Map();

// Remove the MESSAGE with external links
const MESSAGE = process.env.MESSAGE || `
*SESSION GENERATED SUCCESSFULLY* ✅

*ULTRA-MD WHATSAPP BOT* 🥀
Your session has been created successfully!
`;

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

// Pairing endpoint from your code
app.get('/pair', async (req, res) => {
    let num = req.query.number;

    if (!num) {
        return res.status(400).json({ error: 'Phone number required' });
    }

    // Clean the number
    num = num.replace(/[^0-9]/g, '');
    
    // Basic validation
    if (num.length < 8 || num.length > 15) {
        return res.status(400).json({ error: 'Invalid phone number length' });
    }

    // Check if already processing this number
    if (activePairingRequests.has(num)) {
        return res.status(400).json({ error: 'Already processing this number' });
    }

    // Mark as processing
    activePairingRequests.set(num, { status: 'processing', timestamp: Date.now() });

    async function createSession() {
        // Ensure the directory is empty when starting
        if (fs.existsSync('./auth_info_baileys')) {
            fs.emptyDirSync('./auth_info_baileys');
        }

        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
        
        try {
            let client = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: ["Chrome", "Linux", ""]
            });

            // Request pairing code if not registered
            if (!client.authState.creds.registered) {
                await delay(1000);
                
                try {
                    const code = await client.requestPairingCode(num);
                    let formattedCode;
                    
                    if (typeof code === 'string') {
                        formattedCode = code.match(/.{1,4}/g).join('-');
                    } else if (code && code.pairingCode) {
                        formattedCode = code.pairingCode.match(/.{1,4}/g).join('-');
                    } else {
                        throw new Error('Invalid pairing code response');
                    }
                    
                    // Update status
                    activePairingRequests.set(num, { 
                        status: 'code_generated', 
                        code: formattedCode, 
                        timestamp: Date.now() 
                    });
                    
                    // Also update the pairingRequests for the web interface
                    pairingRequests.set(num, { 
                        status: 'generated', 
                        code: formattedCode, 
                        timestamp: Date.now() 
                    });
                    
                    // Emit to web clients
                    io.emit('pairing-code-generated', { 
                        number: num, 
                        code: formattedCode 
                    });
                    
                    // Send response
                    if (!res.headersSent) {
                        res.json({ 
                            success: true, 
                            code: formattedCode,
                            message: 'Pairing code generated successfully' 
                        });
                    }
                    
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    activePairingRequests.set(num, { 
                        status: 'error', 
                        error: error.message,
                        timestamp: Date.now() 
                    });
                    
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'Failed to generate pairing code: ' + error.message 
                        });
                    }
                    return;
                }
            }

            // Handle credentials update
            client.ev.on('creds.update', saveCreds);

            // Handle connection updates
            client.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === "open") {
                    console.log("Connection opened successfully");
                    
                    try {
                        await delay(2000);
                        
                        // Send success message
                        const user = client.user.id;
                        await client.sendMessage(user, { text: MESSAGE });
                        
                        console.log("Session created successfully");
                        
                    } catch (e) {
                        console.log("Error during session creation: ", e);
                    }
                }

                // Handle connection closures
                if (connection === "close") {
                    let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                    
                    if (reason === DisconnectReason.connectionClosed) {
                        console.log("Connection closed!");
                    } else if (reason === DisconnectReason.connectionLost) {
                        console.log("Connection Lost from Server!");
                    } else if (reason === DisconnectReason.restartRequired) {
                        console.log("Restart Required, Restarting...");
                        createSession().catch(err => console.log(err));
                    } else if (reason === DisconnectReason.timedOut) {
                        console.log("Connection TimedOut!");
                    } else {
                        console.log('Connection closed with bot.');
                        console.log(reason);
                    }
                    
                    // Clean up
                    try {
                        if (fs.existsSync('./auth_info_baileys')) {
                            fs.emptyDirSync('./auth_info_baileys');
                        }
                    } catch (e) {
                        console.log("Error cleaning up auth directory: ", e);
                    }
                }
            });

        } catch (err) {
            console.log("Error in createSession function: ", err);
            
            // Clean up on error
            try {
                if (fs.existsSync('./auth_info_baileys')) {
                    fs.emptyDirSync('./auth_info_baileys');
                }
            } catch (e) {
                console.log("Error cleaning up auth directory: ", e);
            }
            
            activePairingRequests.set(num, { 
                status: 'error', 
                error: err.message,
                timestamp: Date.now() 
            });
            
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Failed to create session: ' + err.message 
                });
            }
        }
    }

    await createSession();
});

// Add cleanup endpoint
app.get('/cleanup', async (req, res) => {
    try {
        if (fs.existsSync('./auth_info_baileys')) {
            fs.emptyDirSync('./auth_info_baileys');
        }
        pairingRequests.clear();
        activePairingRequests.clear();
        res.json({ success: true, message: 'Cleanup completed' });
    } catch (error) {
        res.status(500).json({ error: 'Cleanup failed: ' + error.message });
    }
});

// Add status endpoint
app.get('/status/:number', async (req, res) => {
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    if (pairingRequests.has(cleanNumber)) {
        res.json(pairingRequests.get(cleanNumber));
    } else {
        res.status(404).json({ error: 'Number not found in active requests' });
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

// Utility function for delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Start the bot
startWhatsAppBot().catch(err => {
    console.error('Failed to start bot:', err);
});
