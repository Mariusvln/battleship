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

// --- FIXED ASSET ROUTING DIRECTORY ---
// This ensures Express reads the 'public' folder right next to your server file
app.use(express.static(path.join(__dirname, 'public')));
// Fallback if public is at your repository root level instead:
app.use(express.static(path.join(__dirname, '../public')));

let globalSession = createFreshSession();
let disconnectTimers = new Map();

function createFreshSession() {
    return {
        status: 'LOBBY',
        players: [],
        userIds: [],
        turnIdx: 0,
        gameState: {}
    };
}

function createEmptyBoard() {
    return Array(10).fill(null).map(() => Array(10).fill(0));
}

function broadcastSessionStatus() {
    const payload = {
        status: globalSession.status,
        playerCount: globalSession.players.length,
        slotsConnected: globalSession.userIds
    };
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(JSON.stringify({ type: 'SESSION_STATUS_UPDATE', payload }));
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
    for (let timer of disconnectTimers.values()) clearTimeout(timer);
    disconnectTimers.clear();

    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'SESSION_RESET', message: reasonMessage }));
            client.isInSession = false;
        }
    });

    globalSession = createFreshSession();
    broadcastSessionStatus();
}

wss.on('connection', (ws) => {
    ws.userId = uuidv4();
    ws.isInSession = false;

    ws.send(JSON.stringify({ type: 'INIT_CLIENT', payload: { userId: ws.userId } }));
    broadcastSessionStatus();

    ws.on('message', (message) => {
        try {
            const packet = JSON.parse(message);
            handleClientAction(ws, packet);
        } catch (err) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Malformed data dropped.' }));
        }
    });

    ws.on('close', () => {
        if (!ws.isInSession) return;
        globalSession.players = globalSession.players.filter(p => p.userId !== ws.userId);

        const timerId = setTimeout(() => {
            resetEntireSession(`Recovery window expired for user ${ws.userId.substring(0,5)}.`);
        }, 60000);

        disconnectTimers.set(ws.userId, timerId);

        globalSession.players.forEach(p => {
            p.send(JSON.stringify({ 
                type: 'OPPONENT_TEMPORARILY_OFFLINE', 
                message: 'Opponent disconnected. 60s recovery window active.' 
            }));
        });
        broadcastSessionStatus();
    });
});

function handleClientAction(ws, packet) {
    const { type, payload } = packet;

    if (type === 'JOIN_SESSION') {
        if (globalSession.userIds.includes(ws.userId)) {
            if (disconnectTimers.has(ws.userId)) {
                clearTimeout(disconnectTimers.get(ws.userId));
                disconnectTimers.delete(ws.userId);
            }
            const oldIdx = globalSession.userIds.indexOf(ws.userId);
            globalSession.players[oldIdx] = ws;
            ws.isInSession = true;

            ws.send(JSON.stringify({ type: 'JOIN_SUCCESS' }));
            if (globalSession.status === 'BATTLE') sendTurnUpdate();
            else broadcastSessionStatus();
            return;
        }

        if (globalSession.players.length >= 2 || (globalSession.status !== 'LOBBY' && globalSession.status !== 'PLACEMENT')) {
            return ws.send(JSON.stringify({ type: 'ERROR', message: 'Session is full or unavailable.' }));
        }

        globalSession.players.push(ws);
        globalSession.userIds.push(ws.userId);
        ws.isInSession = true;

        globalSession.gameState[ws.userId] = {
            board: createEmptyBoard(),
            hits: createEmptyBoard(),
            ready: false
        };

        if (globalSession.players.length === 2) globalSession.status = 'PLACEMENT';

        ws.send(JSON.stringify({ type: 'JOIN_SUCCESS' }));
        broadcastSessionStatus();
        return;
    }

    if (type === 'LEAVE_SESSION') {
        if (!ws.isInSession) return;
        resetEntireSession(`A player explicitly left the session.`);
        return;
    }

    if (!ws.isInSession) return;

    if (type === 'PLACE_SHIPS') {
        const pState = globalSession.gameState[ws.userId];
        if (!pState || pState.ready) return;

        const { ships } = payload; 
        const tempBoard = createEmptyBoard();

        try {
            for (const ship of ships) {
                for (let i = 0; i < ship.size; i++) {
                    let nx = ship.x + (ship.orientation === 'H' ? i : 0);
                    let ny = ship.y + (ship.orientation === 'V' ? i : 0);
                    
                    if (nx < 0 || nx >= 10 || ny < 0 || ny >= 10 || tempBoard[ny][nx] !== 0) {
                        throw new Error('Collision encountered.');
                    }
                    tempBoard[ny][nx] = ship.size;
                }
            }
        } catch (e) {
            return ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid ship placement received.' }));
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
        if (activePlayer.userId !== ws.userId) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Not your turn.' }));

        const opponent = globalSession.players[(globalSession.turnIdx + 1) % 2];
        const { x, y } = payload;

        if (x < 0 || x >= 10 || y < 0 || y >= 10) return;
        if (globalSession.gameState[ws.userId].hits[y][x] !== 0) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Already targeted.' }));

        const targetCell = globalSession.gameState[opponent.userId].board[y][x];
        let hit = false;

        if (targetCell > 0) {
            hit = true;
            globalSession.gameState[ws.userId].hits[y][x] = 2; 
            globalSession.gameState[opponent.userId].board[y][x] = -1;
        } else {
            globalSession.gameState[ws.userId].hits[y][x] = 1; 
        }

        const opponentDefeated = globalSession.gameState[opponent.userId].board.every(row => row.every(cell => cell <= 0));

        ws.send(JSON.stringify({ type: 'FIRE_RESULT', payload: { x, y, hit, target: 'opponent' } }));
        opponent.send(JSON.stringify({ type: 'FIRE_RESULT', payload: { x, y, hit, target: 'self' } }));

        if (opponentDefeated) {
            globalSession.status = 'FINISHED';
            globalSession.players.forEach(p => p.send(JSON.stringify({ type: 'GAME_OVER', payload: { winner: ws.userId } })));
            resetEntireSession("Game over. Resetting global arena session.");
        } else {
            if (!hit) globalSession.turnIdx = (globalSession.turnIdx + 1) % 2;
            sendTurnUpdate();
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Battleship Server executing on port ${PORT}`));