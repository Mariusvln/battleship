import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- SINGLETON SESSION ARCHITECTURE ---
let globalSession = createFreshSession();
let disconnectTimers = new Map(); // Tracks grace windows for user recovery

function createFreshSession() {
    return {
        status: 'LOBBY', // LOBBY, PLACEMENT, BATTLE, FINISHED
        players: [],     // Array of live WebSocket objects (Max 2)
        userIds: [],     // Historical trace of registered user strings in session
        turnIdx: 0,
        gameState: {}    // Holds structural grid maps
    };
}

function createEmptyBoard() {
    return Array(10).fill(null).map(() => Array(10).fill(0));
}

// --- GLOBAL STATE SYNCHRONIZATION ---
function broadcastSessionStatus() {
    const payload = {
        status: globalSession.status,
        playerCount: globalSession.players.length,
        slotsConnected: globalSession.userIds
    };
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'SESSION_STATUS_UPDATE', payload }));
        }
    });
}

function sendTurnUpdate() {
    globalSession.players.forEach((p, idx) => {
        p.send(JSON.stringify({
            type: 'TURN_UPDATE',
            payload: { isYourTurn: idx === globalSession.turnIdx, status: globalSession.status }
        }));
    });
}

function resetEntireSession(reasonMessage) {
    // Clear any dangling disconnection timers
    for (let timer of disconnectTimers.values()) clearTimeout(timer);
    disconnectTimers.clear();

    // Alert all connected clients
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'SESSION_RESET', message: reasonMessage }));
            // Reset client bindings
            client.isInSession = false;
        }
    });

    globalSession = createFreshSession();
    broadcastSessionStatus();
}

// --- WEBSOCKET ENGINE ---
wss.on('connection', (ws) => {
    ws.userId = uuidv4();
    ws.isInSession = false;

    // Immediately inform the new connection of the current global space state
    ws.send(JSON.stringify({ type: 'INIT_CLIENT', payload: { userId: ws.userId } }));
    broadcastSessionStatus();

    ws.on('message', (message) => {
        try {
            const packet = JSON.parse(message);
            handleClientAction(ws, packet);
        } catch (err) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Malformed frame data dropped.' }));
        }
    });

    ws.on('close', () => {
        handleGracefulDisconnect(ws);
    });
});

function handleClientAction(ws, packet) {
    const { type, payload } = packet;

    if (type === 'JOIN_SESSION') {
        // If they are returning from an accidental disconnection/refresh drop
        if (globalSession.userIds.includes(ws.userId)) {
            if (disconnectTimers.has(ws.userId)) {
                clearTimeout(disconnectTimers.get(ws.userId));
                disconnectTimers.delete(ws.userId);
            }
            // Replace old connection with new socket reference
            const oldIdx = globalSession.userIds.indexOf(ws.userId);
            globalSession.players[oldIdx] = ws;
            ws.isInSession = true;

            ws.send(JSON.stringify({ type: 'JOIN_SUCCESS' }));
            
            // Catch up client on game loop state
            if (globalSession.status === 'BATTLE') {
                sendTurnUpdate();
            } else {
                broadcastSessionStatus();
            }
            return;
        }

        // Standard entry block validation rules
        if (globalSession.players.length >= 2) {
            return ws.send(JSON.stringify({ type: 'ERROR', message: 'Session is currently full. Spectating/Waiting.' }));
        }
        if (globalSession.status !== 'LOBBY' && globalSession.status !== 'PLACEMENT') {
            return ws.send(JSON.stringify({ type: 'ERROR', message: 'Game already in progress. Cannot hot-join.' }));
        }

        globalSession.players.push(ws);
        globalSession.userIds.push(ws.userId);
        ws.isInSession = true;

        globalSession.gameState[ws.userId] = {
            board: createEmptyBoard(),
            hits: createEmptyBoard(),
            ready: false
        };

        if (globalSession.players.length === 2) {
            globalSession.status = 'PLACEMENT';
        }

        ws.send(JSON.stringify({ type: 'JOIN_SUCCESS' }));
        broadcastSessionStatus();
        return;
    }

    if (type === 'LEAVE_SESSION') {
        if (!ws.isInSession) return;
        resetEntireSession(`Player ${ws.userId.substring(0,5)} explicitly left the arena.`);
        return;
    }

    // --- PROTECTED GAME MATRIX ACTIONS ---
    if (!ws.isInSession) return;

    if (type === 'PLACE_SHIPS') {
        const pState = globalSession.gameState[ws.userId];
        if (!pState || pState.ready) return;

        const { ships } = payload;
        const tempBoard = createEmptyBoard();

        // Server-side geometry validation placement rules
        for (const ship of ships) {
            for (let i = 0; i < ship.size; i++) {
                let nx = ship.x + (ship.orientation === 'H' ? i : 0);
                let ny = ship.y + (ship.orientation === 'V' ? i : 0);
                if (nx < 0 || nx >= 10 || ny < 0 || ny >= 10 || tempBoard[ny][nx] !== 0) {
                    return ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid configuration geometries detected' }));
                }
                tempBoard[ny][nx] = ship.size;
            }
        }

        pState.board = tempBoard;
        pState.ready = true;
        ws.send(JSON.stringify({ type: 'PLACEMENT_CONFIRMED' }));

        const allReady = globalSession.players.every(p => globalSession.gameState[p.userId]?.ready);
        if (allReady && globalSession.players.length === 2) {
            globalSession.status = 'BATTLE';
            sendTurnUpdate();
        } else {
            broadcastSessionStatus();
        }
        return;
    }

    if (type === 'FIRE_SHOT') {
        if (globalSession.status !== 'BATTLE') return;
        const activePlayer = globalSession.players[globalSession.turnIdx];
        if (activePlayer.userId !== ws.userId) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Not your system turn assignment!' }));

        const opponent = globalSession.players[(globalSession.turnIdx + 1) % 2];
        const { x, y } = payload;

        if (x < 0 || x >= 10 || y < 0 || y >= 10) return;
        if (globalSession.gameState[ws.userId].hits[y][x] !== 0) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Target sector locked previously.' }));

        const targetCell = globalSession.gameState[opponent.userId].board[y][x];
        let hit = false;

        if (targetCell > 0) {
            hit = true;
            globalSession.gameState[ws.userId].hits[y][x] = 2; // Hit token
            globalSession.gameState[opponent.userId].board[y][x] = -1; // Damage frame mapping
        } else {
            globalSession.gameState[ws.userId].hits[y][x] = 1; // Miss token
        }

        // Calculate if game win state evaluates true
        const opponentDefeated = globalSession.gameState[opponent.userId].board.every(row => row.every(cell => cell <= 0));

        ws.send(JSON.stringify({ type: 'FIRE_RESULT', payload: { x, y, hit, target: 'opponent' } }));
        opponent.send(JSON.stringify({ type: 'FIRE_RESULT', payload: { x, y, hit, target: 'self' } }));

        if (opponentDefeated) {
            globalSession.status = 'FINISHED';
            globalSession.players.forEach(p => {
                p.send(JSON.stringify({ type: 'GAME_OVER', payload: { winner: ws.userId } }));
            });
            setTimeout(() => {
                resetEntireSession("Previous game completed successfully. Operational system recycling done.");
            }, 5000);
        } else {
            if (!hit) globalSession.turnIdx = (globalSession.turnIdx + 1) % 2;
            sendTurnUpdate();
        }
    }
}

function handleGracefulDisconnect(ws) {
    if (!ws.isInSession) return;

    // Remove the socket reference from current loop pools
    globalSession.players = globalSession.players.filter(p => p.userId !== ws.userId);

    // Fire off a 60-second network recovery grace timer
    const timerId = setTimeout(() => {
        resetEntireSession(`Player ${ws.userId.substring(0,5)} failed to recover within 60 seconds.`);
    }, 60000);

    disconnectTimers.set(ws.userId, timerId);
    
    // Warn the remaining user inside the session room instantly
    globalSession.players.forEach(p => {
        p.send(JSON.stringify({ 
            type: 'OPPONENT_TEMPORARILY_OFFLINE', 
            message: 'Opponent connection severed. 60-second recovery timer countdown active.' 
        }));
    });

    broadcastSessionStatus();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Battleship Dedicated Singleton Core Server running on port ${PORT}`));