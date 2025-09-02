const express = require('express');
const fs = require('fs-extra');
const { exec } = require("child_process");
let router = express.Router();
const pino = require("pino");
const { Boom } = require("@hapi/boom");

// Remove the MESSAGE with external links
const MESSAGE = process.env.MESSAGE || `
*SESSION GENERATED SUCCESSFULLY* ✅

*ULTRA-MD WHATSAPP BOT* 🥀
Your session has been created successfully!
`;

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    DisconnectReason
} = require("@whiskeysockets/baileys");

// Store active pairing requests
const activePairingRequests = new Map();

router.get('/', async (req, res) => {
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
                browser: Browsers.macOS("Safari"),
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
router.get('/cleanup', async (req, res) => {
    try {
        if (fs.existsSync('./auth_info_baileys')) {
            fs.emptyDirSync('./auth_info_baileys');
        }
        activePairingRequests.clear();
        res.json({ success: true, message: 'Cleanup completed' });
    } catch (error) {
        res.status(500).json({ error: 'Cleanup failed: ' + error.message });
    }
});

// Add status endpoint
router.get('/status/:number', async (req, res) => {
    const { number } = req.params;
    const cleanNumber = number.replace(/[^0-9]/g, '');
    
    if (activePairingRequests.has(cleanNumber)) {
        res.json(activePairingRequests.get(cleanNumber));
    } else {
        res.status(404).json({ error: 'Number not found in active requests' });
    }
});

module.exports = router;
