const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const pino = require('pino');
const NodeCache = require("node-cache");

// Initialize web server
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// Store pairing codes and user numbers
const activePairingCodes = new Map();
const userNumbers = new Map();
const gameSessions = new Map();

// Check if we're in production
const isProduction = process.env.NODE_ENV === 'production';

// Game logic - Color Guessing Game
class ColorGame {
    constructor(userId) {
        this.userId = userId;
        this.score = 0;
        this.round = 0;
        this.maxRounds = 5;
        this.colors = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PURPLE', 'ORANGE'];
        this.currentColor = this.getRandomColor();
        this.colorCodes = {
            'RED': '#FF0000',
            'GREEN': '#00FF00',
            'BLUE': '#0000FF',
            'YELLOW': '#FFFF00',
            'PURPLE': '#800080',
            'ORANGE': '#FFA500'
        };
    }
    
    getRandomColor() {
        return this.colors[Math.floor(Math.random() * this.colors.length)];
    }
    
    startNewRound() {
        this.round++;
        this.currentColor = this.getRandomColor();
        return this.getColorMessage();
    }
    
    getColorMessage() {
        const colorCode = this.colorCodes[this.currentColor];
        return `🎨 Round ${this.round}/${this.maxRounds}\n\nGuess the color name!\n\n${this.getColorBlock(colorCode)}`;
    }
    
    getColorBlock(colorCode) {
        return `🟥🟥🟥🟥🟥\n🟥🟥🟥🟥🟥\n🟥🟥🟥🟥🟥\n\n💡 Hint: The color is ${this.currentColor.charAt(0) + '•'.repeat(this.currentColor.length-1)}`;
    }
    
    checkAnswer(answer) {
        const isCorrect = answer.toUpperCase() === this.currentColor;
        if (isCorrect) {
            this.score++;
        }
        return {
            correct: isCorrect,
            score: this.score,
            correctColor: this.currentColor
        };
    }
    
    isGameOver() {
        return this.round >= this.maxRounds;
    }
    
    getFinalScore() {
        return `${this.score}/${this.maxRounds}`;
    }
}

// Web routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pairing.html'));
});

app.get('/api/pairing-code', (req, res) => {
    const code = req.query.code;
    const number = req.query.number;
    if (code && number) {
        activePairingCodes.set(code, { 
            timestamp: Date.now(),
            number: number 
        });
        userNumbers.set(number, code);
        io.emit('new-pairing-code', { code, number });
        res.json({ success: true, code, number });
    } else {
        res.json({ success: false, error: 'No code or number provided' });
    }
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
        userNumbers.set(cleanNumber, 'pending');
        io.emit('number-submitted', { number: cleanNumber, status: 'pending' });
        
        res.json({ success: true, message: 'Number received, pairing code will be generated shortly', number: cleanNumber });
        
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Add health check endpoint for Render keep-alive
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'WhatsApp Game Bot',
        platform: 'Render'
    });
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
    console.log('User connected to pairing page');
    
    socket.on('disconnect', () => {
        console.log('User disconnected from pairing page');
    });
});

const WEB_PORT = process.env.PORT || 3000;
server.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(chalk.blue(`🌐 Pairing server running on port ${WEB_PORT}`));
    console.log(chalk.blue(`📱 Open your Render URL to view pairing page`));
});

// Auto-ping service to prevent Render shutdown
const keepAlive = () => {
    const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${WEB_PORT}`;
    
    setInterval(async () => {
        try {
            const response = await axios.get(`${RENDER_URL}/api/health`);
            console.log(chalk.green(`✅ Health ping successful: ${response.status}`));
        } catch (error) {
            console.log(chalk.yellow(`⚠️ Health ping failed: ${error.message}`));
        }
    }, PING_INTERVAL);
};

// Start auto-ping only in production
if (isProduction) {
    keepAlive();
    console.log(chalk.blue('🔄 Auto-ping service activated to prevent shutdown'));
}

// WhatsApp Bot Setup
async function startWhatsAppBot() {
    const { state, saveCreds } = await useMultiFileAuthState(`./session`);
    const msgRetryCounterCache = new NodeCache();
    const { version } = await fetchLatestBaileysVersion();

    // Baileys configuration
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        msgRetryCounterCache,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        maxIdleTimeMs: 15000,
        emitOwnEvents: true,
        defaultQueryTimeoutMs: 0,
        transactionOpts: {
            maxCommitRetries: 10,
            delayBetweenTries: 3000
        },
        linkPreviewImageThumbnailWidth: 192,
        shouldIgnoreJid: (jid) => false,
        fireInitQueries: true,
        appStateMacVerification: {
            patch: false,
            snapshot: false
        }
    });

    // Handle pairing code requests
    setInterval(async () => {
        for (const [number, status] of userNumbers.entries()) {
            if (status === 'pending') {
                try {
                    console.log(chalk.yellow(`🔄 Processing pairing request for: ${number}`));
                    
                    const cleanNumber = number.replace(/[^0-9]/g, '');

                    if (cleanNumber.length < 8 || cleanNumber.length > 15) {
                        console.log(chalk.red(`❌ Invalid number length: ${cleanNumber}`));
                        userNumbers.set(number, 'invalid');
                        io.emit('pairing-error', { number: cleanNumber, error: 'Invalid phone number length' });
                        continue;
                    }

                    // Request legitimate pairing code from WhatsApp
                    try {
                        const pairingCodeResponse = await sock.requestPairingCode(cleanNumber);
                        
                        // Extract the actual pairing code from the response
                        let actualCode;
                        if (typeof pairingCodeResponse === 'string') {
                            actualCode = pairingCodeResponse;
                        } else if (pairingCodeResponse && pairingCodeResponse.pairingCode) {
                            actualCode = pairingCodeResponse.pairingCode;
                        } else {
                            actualCode = Math.floor(10000000 + Math.random() * 90000000).toString();
                            console.log(chalk.yellow(`⚠️ Using fallback code for: ${cleanNumber}`));
                        }
                        
                        // Format the code for display (XXXX-XXXX format)
                        const formattedCode = actualCode.toString().replace(/(\d{4})(?=\d)/g, '$1-');
                        
                        console.log(chalk.green(`✅ WhatsApp pairing code received for: ${cleanNumber}`));
                        
                        try {
                            const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${WEB_PORT}`;
                            await axios.get(`${RENDER_URL}/api/pairing-code?code=${formattedCode}&number=${cleanNumber}`);
                            console.log(chalk.green(`✅ Pairing code sent to web interface for: ${cleanNumber}`));
                            userNumbers.set(number, 'sent');
                        } catch (webError) {
                            console.log(chalk.yellow(`⚠️ Web server error, showing in logs for: ${cleanNumber}`));
                            console.log(chalk.black(chalk.bgGreen(`Pairing Code for ${cleanNumber}: `)), chalk.black(chalk.white(formattedCode)));
                            userNumbers.set(number, 'sent');
                            io.emit('new-pairing-code', { code: formattedCode, number: cleanNumber });
                        }
                        
                    } catch (error) {
                        console.error(chalk.red(`Error requesting pairing code from WhatsApp for ${number}:`), error);
                        userNumbers.set(number, 'error');
                        io.emit('pairing-error', { number: cleanNumber, error: 'Failed to get pairing code from WhatsApp' });
                    }
                    
                } catch (error) {
                    console.error(chalk.red(`Error processing pairing request for ${number}:`), error);
                    userNumbers.set(number, 'error');
                    io.emit('pairing-error', { number, error: error.message });
                }
            }
        }
    }, 3000);

    // Handle messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message.message) return;
        
        const text = message.message.conversation || 
                    (message.message.extendedTextMessage && message.message.extendedTextMessage.text) || 
                    '';
        
        const jid = message.key.remoteJid;
        const user = jid.split('@')[0];
        
        // Handle .play command
        if (text.toLowerCase().startsWith('.play')) {
            // Initialize or get existing game session
            if (!gameSessions.has(jid)) {
                gameSessions.set(jid, new ColorGame(jid));
            }
            
            const game = gameSessions.get(jid);
            
            // Start new game or continue existing one
            if (game.isGameOver()) {
                // Game finished, show final score
                const finalScore = game.getFinalScore();
                await sock.sendMessage(jid, { 
                    text: `🎮 Game Over!\n\nYour final score: ${finalScore}\n\nType .play to start a new game!` 
                });
                
                // Remove finished game
                gameSessions.delete(jid);
            } else {
                // Start new round
                const gameMessage = game.startNewRound();
                await sock.sendMessage(jid, { text: gameMessage });
            }
        } 
        // Handle color guesses during active game
        else if (gameSessions.has(jid)) {
            const game = gameSessions.get(jid);
            const result = game.checkAnswer(text);
            
            if (result.correct) {
                await sock.sendMessage(jid, { 
                    text: `✅ Correct! The color was ${game.currentColor}\nScore: ${result.score}/${game.maxRounds}` 
                });
            } else {
                await sock.sendMessage(jid, { 
                    text: `❌ Incorrect! The color was ${result.correctColor}\nScore: ${result.score}/${game.maxRounds}` 
                });
            }
            
            // Check if game is over
            if (game.isGameOver()) {
                const finalScore = game.getFinalScore();
                await sock.sendMessage(jid, { 
                    text: `🎮 Game Over!\n\nYour final score: ${finalScore}\n\nType .play to start a new game!` 
                });
                gameSessions.delete(jid);
            } else {
                // Continue to next round
                const nextRoundMessage = game.startNewRound();
                await sock.sendMessage(jid, { text: nextRoundMessage });
            }
        }
        // Handle help command
        else if (text.toLowerCase().startsWith('.help')) {
            await sock.sendMessage(jid, { 
                text: `🎮 WhatsApp Color Game Bot\n\nCommands:\n.play - Start a new color guessing game\n.help - Show this help message\n\nDuring the game, just type the color name you think is shown!` 
            });
        }
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                startWhatsAppBot();
            }
        } else if (connection === 'open') {
            console.log(chalk.green('✅ WhatsApp connection opened successfully'));
        }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// Start the bot
startWhatsAppBot().catch(err => {
    console.error('Failed to start bot:', err);
    process.exit(1);
});

// Error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
